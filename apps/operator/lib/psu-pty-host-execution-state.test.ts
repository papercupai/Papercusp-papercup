// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideLoopExecutionRecovery, type ExecutionRecoveryInput } from '@papercusp/operator-core/lib/harness/routines/loop-execution-recovery';
import { makeAgentBusyGate, nativeExecutionBlocksInjection, nativeExecutionFromRows, nativeTurnVerifierSupport,
  nativeLatestExecution, nativeLatestTurnCompleted, retainNativeExecutionObservation,
  retainPendingNativeExecution, retainRunningNativeExecution } from '../scripts/psu-pty-host.mjs';

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
    expect(failed).toMatchObject({ phase: 'failed', pendingTools: 1,
      failure: { code: 'server_overloaded', retryable: true, retryAfterMs: 60_000, atMs: 1000 } });
    expect(nativeExecutionBlocksInjection(failed)).toBe(true);
    rows.push({ type: 'response_item', timestamp, payload: { type: 'function_call_output', call_id: 'effect' } });
    expect(nativeExecutionFromRows(rows, { agent: 'codex', ...ctx })).toMatchObject({ phase: 'failed', pendingTools: 0 });

    for (const error of [null, undefined]) {
      const success = nativeExecutionFromRows([
        { type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: 'successful-turn' } },
        { type: 'event_msg', timestamp, payload: { type, turn_id: 'successful-turn', error } },
      ], { agent: 'codex', ...ctx });
      expect(success).toMatchObject({ phase: 'settled', pendingTools: 0 });
      expect(success).not.toHaveProperty('failure');
    }
  });

  it.each([
    { info: { response_too_many_failed_attempts: { http_status_code: 429 } },
      code: 'response_too_many_failed_attempts', retryable: false },
    { info: { server_overloaded: {} }, code: 'server_overloaded', retryable: true },
    { info: { invalid_request: {} }, code: 'invalid_request', retryable: false },
    { info: { first: {}, second: {} }, code: 'task_complete', retryable: false },
  ])('preserves structured Codex error classification as $code', ({ info, code, retryable }) => {
    const observed = nativeExecutionFromRows([
      { type: 'event_msg', timestamp, payload: { type: 'task_started' } },
      { type: 'response_item', timestamp, payload: { type: 'function_call', call_id: 'unresolved-effect' } },
      { type: 'event_msg', timestamp, payload: { type: 'task_complete',
        error: { codex_error_info: info, message: 'exceeded retry limit, last status: 429 Too Many Requests' } } },
    ], { agent: 'codex', ...ctx });
    expect(observed).toMatchObject({ phase: 'failed', pendingTools: 1,
      failure: { code, retryable, retryAfterMs: retryable ? 60_000 : null, atMs: 1000 } });
    expect(nativeExecutionBlocksInjection(observed)).toBe(true);
  });

  it('scopes failure metadata to the current turn and submission floor', () => {
    const failure = { type: 'event_msg', timestamp, payload: { type: 'task_complete', turn_id: 'failed',
      error: { codex_error_info: 'server_overloaded', message: 'Selected model is at capacity. Try again in 2 minutes.' } } };
    const observe = (rows: any[], receivedAtMs = 900) => nativeExecutionFromRows(rows,
      { agent: 'codex', nowMs: 2000, receivedAtMs });
    expect(observe([failure]).failure?.retryAfterMs).toBe(120_000);
    expect(observe([failure], 1001)).not.toHaveProperty('failure');
    for (const type of ['task_started', 'task_complete']) {
      const next = { ...failure, timestamp: new Date(1100).toISOString(), payload: { type, turn_id: 'next' } };
      expect(observe([failure, next])).not.toHaveProperty('failure');
    }
    const permanent = { ...failure, payload: { ...failure.payload,
      error: { codex_error_info: 'invalid_request', message: 'Invalid request' } } };
    expect(observe([permanent]).failure).toEqual({ code: 'invalid_request', retryable: false, retryAfterMs: null, atMs: 1000 });
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

  it('retains an unresolved AskUserQuestion across a later terminal-input floor until its result lands', () => {
    const ask = {
      type: 'assistant', timestamp: new Date(1000).toISOString(),
      message: { role: 'assistant', stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'ask-1', name: 'AskUserQuestion', input: { questions: [] } }] },
    };
    const previous = nativeExecutionFromRows([ask], { agent: 'claude', receivedAtMs: 900, nowMs: 2000 });
    expect(previous).toMatchObject({ phase: 'running', pendingTools: 1, pendingGateTools: 1,
      pendingGateToolIds: ['ask-1'] });

    const laterOwnerInput = {
      type: 'user', timestamp: new Date(3000).toISOString(),
      message: { role: 'user', content: 'typed after the dialog opened' },
    };
    const afterFloor = nativeExecutionFromRows([laterOwnerInput], {
      agent: 'claude', receivedAtMs: 3000, nowMs: 4000,
    });
    expect(afterFloor.phase).toBe('unknown');
    const retained = retainPendingNativeExecution(previous, afterFloor, { sameChild: true });
    expect(retained).toMatchObject({ phase: 'running', pendingTools: 1, pendingGateTools: 1,
      pendingGateToolIds: ['ask-1'] });
    expect(nativeExecutionBlocksInjection(retained)).toBe(true);

    const result = {
      ...laterOwnerInput,
      timestamp: new Date(3500).toISOString(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ask-1', content: 'answered' }] },
    };
    const afterResult = nativeExecutionFromRows([result], {
      agent: 'claude', receivedAtMs: 3000, nowMs: 4000,
    });
    const resolved = retainPendingNativeExecution(previous, afterResult, { sameChild: true });
    expect(resolved).toMatchObject({ phase: 'unknown', pendingTools: 0, pendingGateTools: 0 });
    expect(nativeExecutionBlocksInjection(resolved)).toBe(false);
    expect(retainPendingNativeExecution(previous, afterFloor, { sameChild: false })).toBe(afterFloor);
  });

  describe('EI-27244198558252718: an answered gate never stays retained', () => {
    // The su-f9f01e3c incident (2026-10-28): AskUserQuestion at 14:01:57, answered
    // 14:04:59, turn completed 14:10:15. Owner input then moved the floor past the
    // result row. The retained gate vetoed every prompt for 3h, so the queued
    // carry-respawn never fired and 86 wakes were deferred behind it.
    const at = (ms: number) => new Date(ms).toISOString();
    const ask = {
      type: 'assistant', timestamp: at(1000),
      message: { role: 'assistant', stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'ask-1', name: 'AskUserQuestion', input: { questions: [] } }] },
    };
    const answer = {
      type: 'user', timestamp: at(2000),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ask-1', content: 'answered' }] },
    };
    const work = {
      type: 'assistant', timestamp: at(3000),
      message: { role: 'assistant', stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'work-1', name: 'Bash', input: {} }] },
    };
    const workResult = {
      type: 'user', timestamp: at(3500),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'work-1', content: 'ok' }] },
    };
    // A real Claude row always carries `uuid`; classifyClaudeTranscriptRow
    // refuses to certify a turn boundary from a row without one.
    const done = {
      type: 'assistant', uuid: 'done-1', timestamp: at(4000),
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
    };
    const rows = [ask, answer, work, workResult, done];
    const dialogOpen = nativeExecutionFromRows([ask], { agent: 'claude', receivedAtMs: 900, nowMs: 1500 });

    it('clears the gate when the floor moved past its result row, mid-turn and after the turn', () => {
      expect(dialogOpen).toMatchObject({ phase: 'running', pendingGateToolIds: ['ask-1'] });
      // [floor, now, still busy]: mid-turn the floor still scopes genuine work, so
      // the agent reads busy for its own running turn but not for the answered
      // gate. Past the turn the window is empty (phase unknown), which is the
      // f9f01e3c shape: before the fix the retained gate blocked it forever.
      for (const [floor, nowMs, busy] of [[2500, 3800, true], [5000, 6000, false]] as const) {
        const current = nativeExecutionFromRows(rows, { agent: 'claude', receivedAtMs: floor, nowMs });
        expect(current.completedToolIds).toContain('ask-1');
        const observed = retainNativeExecutionObservation(dialogOpen, current, { sameChild: true, sameFence: false });
        expect(observed.pendingGateToolIds ?? []).not.toContain('ask-1');
        expect(observed.pendingGateTools ?? 0).toBe(0);
        expect(nativeExecutionBlocksInjection(observed)).toBe(busy);
      }
    });

    it('drops a retained gate once a completed turn is observed, even without its result row', () => {
      // A bounded transcript tail can evict the result row itself.
      const tailOnly = nativeExecutionFromRows([work, workResult, done], { agent: 'claude', receivedAtMs: 2500, nowMs: 6000 });
      expect(tailOnly.phase).toBe('settled');
      const observed = retainNativeExecutionObservation(dialogOpen, tailOnly, { sameChild: true, sameFence: false });
      expect(observed).toBe(tailOnly);
      expect(nativeExecutionBlocksInjection(observed)).toBe(false);
    });

    it('does not list a gate as pending after the same window shows the turn completed', () => {
      const unanswered = nativeExecutionFromRows([ask, done], { agent: 'claude', receivedAtMs: 900, nowMs: 6000 });
      expect(unanswered).toMatchObject({ phase: 'settled', pendingTools: 0, pendingGateTools: 0, pendingGateToolIds: [] });
    });

    it('still retains a genuinely open gate across an owner-input floor', () => {
      const typed = { type: 'user', timestamp: at(2500), message: { role: 'user', content: 'typed while the dialog is open' } };
      const current = nativeExecutionFromRows([ask, typed], { agent: 'claude', receivedAtMs: 2500, nowMs: 6000 });
      expect(current.completedToolIds).not.toContain('ask-1');
      const observed = retainNativeExecutionObservation(dialogOpen, current, { sameChild: true, sameFence: false });
      expect(observed).toMatchObject({ phase: 'running', pendingGateToolIds: ['ask-1'] });
      expect(nativeExecutionBlocksInjection(observed)).toBe(true);
    });

    it('unblocks the busy gate once the floor-hidden answer is visible as a receipt', async () => {
      let previous: ReturnType<typeof nativeExecutionFromRows> | null = dialogOpen;
      const gate = makeAgentBusyGate({
        lastOutputAt: () => 0,
        quietMs: 10,
        capMs: 50,
        nativeExecution: () => {
          const current = nativeExecutionFromRows(rows, { agent: 'claude', receivedAtMs: 5000, nowMs: 6000 });
          previous = retainNativeExecutionObservation(previous, current, { sameChild: true, sameFence: false });
          return previous;
        },
      });
      await expect(gate.waitAtPrompt(50)).resolves.toMatchObject({ deferred: false });
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

  it('clears a retained owner gate when its result arrives on the same observation fence', () => {
    const previous = {
      phase: 'running', turnStartedAt: 1000, lastProgressAt: 1500, pendingTools: 1,
      pendingToolIds: ['ask-1'], pendingGateTools: 1, pendingGateToolIds: ['ask-1'],
    };
    const result = {
      phase: 'unknown', turnStartedAt: null, lastProgressAt: 2000, pendingTools: 0,
      pendingToolIds: [], completedToolIds: ['ask-1'], pendingGateTools: 0,
      pendingGateToolIds: [], completedGateToolIds: ['ask-1'],
    };
    const observed = retainNativeExecutionObservation(previous, result, {
      sameChild: true, sameFence: true,
    });
    expect(observed).toBe(result);
    expect(nativeExecutionBlocksInjection(observed)).toBe(false);
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
