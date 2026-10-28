import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyzeCodexRolloutFile,
  analyzeCodexRolloutText,
  CODEX_CONTEXT_OVERFLOW_POISON_TURNS,
  findCodexRolloutPath,
} from './codex-rollout-overflow';

// Captured from a real over-window thread (su-codex-homes/session-33944, rollout
// …01a10080…, 2026-10-12 11:09-11:31Z, WI-6554700010008894). Only the event structure,
// error objects and abort reasons are kept; prompt text is redacted. It records three
// PreCompact-refused turns (turn_aborted), then one context-window overflow, then a
// remote-compaction usage-limit failure.
const FIXTURE = readFileSync(join(__dirname, '__fixtures__', 'codex-rollout-over-window.tail.jsonl'), 'utf8');
const lines = FIXTURE.trim().split('\n');
const overflowTurn = lines.slice(15, 19); // task_started … task_complete(context_length_exceeded)
const usageLimitTurn = lines.slice(19, 24);
const completedTurn = [
  '{"timestamp":"2026-10-12T12:00:00.000Z","type":"event_msg","payload":{"type":"task_started","model_context_window":828400}}',
  '{"timestamp":"2026-10-12T12:00:09.000Z","type":"event_msg","payload":{"type":"task_complete","last_agent_message":"done"}}',
];

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'codex-overflow-'));
  roots.push(root);
  return root;
};

describe('analyzeCodexRolloutText on the captured over-window rollout', () => {
  it('counts the overflowed turn and skips the trailing usage-limit failure', () => {
    expect(analyzeCodexRolloutText(FIXTURE)).toEqual({
      trailingContextOverflowTurns: 1,
      lastOverflowAt: '2026-10-12T11:28:18.659Z',
      modelContextWindow: 828400,
      currentTurnOutcome: 'usage-limit',
      currentTurnErrorEvidence: expect.stringMatching(/^Error running remote compact task: You.ve hit your usage limit/),
      // The walled compaction turn wrote nothing before it failed.
      currentTurnProducedOutput: false,
    });
  });

  it('reaches the poison threshold on the next overflowed wake', () => {
    const next = [...lines, ...overflowTurn].join('\n');
    const analysis = analyzeCodexRolloutText(next);
    expect(analysis.trailingContextOverflowTurns).toBe(CODEX_CONTEXT_OVERFLOW_POISON_TURNS);
    expect(analysis.trailingContextOverflowTurns).toBe(2);
  });

  it('does not count PreCompact-refused (aborted) turns as overflow', () => {
    const abortedOnly = lines.slice(0, 15).join('\n');
    expect(analyzeCodexRolloutText(abortedOnly).trailingContextOverflowTurns).toBe(0);
  });

  it('a completed turn ends the streak', () => {
    const recovered = [...overflowTurn, ...overflowTurn, ...completedTurn].join('\n');
    expect(analyzeCodexRolloutText(recovered).trailingContextOverflowTurns).toBe(0);
  });

  it('an abort between overflows ends the streak (it is not evidence the thread is too large)', () => {
    const mixed = [...overflowTurn, ...lines.slice(0, 5), ...overflowTurn].join('\n');
    expect(analyzeCodexRolloutText(mixed).trailingContextOverflowTurns).toBe(1);
  });

  it('usage-limit turns between overflows neither count nor break', () => {
    const walled = [...overflowTurn, ...usageLimitTurn, ...usageLimitTurn, ...overflowTurn].join('\n');
    expect(analyzeCodexRolloutText(walled).trailingContextOverflowTurns).toBe(2);
  });
});

// WI-6554700010029533: a consult answer session's first turn is judged by how the
// turn opened by the newest task_started ended — never by an older turn's ending.
describe('analyzeCodexRolloutText current-turn outcome', () => {
  const started = '{"timestamp":"2026-10-26T15:24:03.445Z","type":"event_msg","payload":{"type":"task_started"}}';
  const failed = (error: unknown): string =>
    JSON.stringify({ timestamp: '2026-10-26T15:24:09.108Z', type: 'event_msg', payload: { type: 'task_complete', error } });

  it('reports the usage-limit wall of the newest turn with the provider message as evidence', () => {
    const walled = [...completedTurn, started, failed({ message: 'You’ve hit your usage limit. Upgrade to Pro' })].join('\n');
    const analysis = analyzeCodexRolloutText(walled);
    expect(analysis.currentTurnOutcome).toBe('usage-limit');
    expect(analysis.currentTurnErrorEvidence).toBe('You’ve hit your usage limit. Upgrade to Pro');
  });

  it('is null while the newest turn is still running, even after an older turn ended', () => {
    const running = [...overflowTurn, ...completedTurn, started].join('\n');
    expect(analyzeCodexRolloutText(running).currentTurnOutcome).toBeNull();
    expect(analyzeCodexRolloutText(running).currentTurnErrorEvidence).toBeNull();
  });

  it('distinguishes ok, context overflow, abort and any other provider error', () => {
    expect(analyzeCodexRolloutText(completedTurn.join('\n'))).toMatchObject({ currentTurnOutcome: 'ok', currentTurnErrorEvidence: null });
    const overflow = analyzeCodexRolloutText(overflowTurn.join('\n'));
    expect(overflow.currentTurnOutcome).toBe('context-overflow');
    expect(overflow.currentTurnErrorEvidence).toMatch(/exceeds the context window/);
    expect(analyzeCodexRolloutText(lines.slice(0, 5).join('\n'))).toMatchObject({ currentTurnOutcome: 'aborted', currentTurnErrorEvidence: null });
    expect(analyzeCodexRolloutText([started, failed({ message: 'stream disconnected before completion' })].join('\n')))
      .toMatchObject({ currentTurnOutcome: 'error', currentTurnErrorEvidence: 'stream disconnected before completion' });
  });

  // WI-6554700010030363: record shapes as Codex 0.159 writes them (su-codex-homes
  // rollouts, 2026-10-27). An item_completed carries the item; turn_aborted the reason.
  describe('whether the newest turn produced output (WI-6554700010030363)', () => {
    const item = (type: string) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type, id: `i-${type}` } } });
    const aborted = JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } });
    const complete = JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'answered' } });

    it('is false for a turn aborted with only its input and reasoning written', () => {
      const analysis = analyzeCodexRolloutText([started, item('UserMessage'), item('Reasoning'), aborted].join('\n'));
      expect(analysis).toMatchObject({ currentTurnOutcome: 'aborted', currentTurnProducedOutput: false });
    });

    it.each(['AgentMessage', 'McpToolCall', 'CommandExecution', 'FileChange'])('is true once the turn wrote a %s', (type) => {
      const analysis = analyzeCodexRolloutText([started, item('UserMessage'), item(type), aborted].join('\n'));
      expect(analysis).toMatchObject({ currentTurnOutcome: 'aborted', currentTurnProducedOutput: true });
    });

    it('never credits an older turn’s output to the newest turn', () => {
      const text = [started, item('AgentMessage'), complete, started, item('UserMessage'), aborted].join('\n');
      expect(analyzeCodexRolloutText(text).currentTurnProducedOutput).toBe(false);
    });

    it('is false when the text holds no turn start', () => {
      expect(analyzeCodexRolloutText(item('AgentMessage')).currentTurnProducedOutput).toBe(false);
    });
  });

  it('bounds the evidence and is null when the text holds no turn start', () => {
    const long = analyzeCodexRolloutText([started, failed('x'.repeat(1000))].join('\n'));
    expect(long.currentTurnOutcome).toBe('error');
    expect(long.currentTurnErrorEvidence).toHaveLength(200);
    expect(analyzeCodexRolloutText('').currentTurnOutcome).toBeNull();
  });
});

describe('analyzeCodexRolloutFile', () => {
  it('reads only a bounded tail and tolerates a first line cut mid-record', () => {
    const root = tempRoot();
    const path = join(root, 'rollout.jsonl');
    writeFileSync(path, [...lines, ...overflowTurn].join('\n') + '\n');
    // A tail that starts 39 bytes into the preceding usage-limit record: that partial
    // record is skipped, the earlier 11:28 overflow is outside the tail, so only the
    // newest overflow is visible.
    const tailBytes = overflowTurn.join('\n').length + 40;
    expect(analyzeCodexRolloutFile(path, tailBytes)?.trailingContextOverflowTurns).toBe(1);
    expect(analyzeCodexRolloutFile(path)?.trailingContextOverflowTurns).toBe(2);
  });

  it('returns null for an unreadable path', () => {
    expect(analyzeCodexRolloutFile(join(tempRoot(), 'missing.jsonl'))).toBeNull();
  });
});

describe('findCodexRolloutPath', () => {
  const sid = '01a10080-4435-7822-8b4f-d82fc7e81227';

  it('finds the rollout for the exact native session id under sessions/<y>/<m>/<d>', () => {
    const home = tempRoot();
    const dir = join(home, 'sessions', '2026', '10', '03');
    mkdirSync(dir, { recursive: true });
    const want = join(dir, `rollout-2026-10-03T02-42-48-${sid}.jsonl`);
    writeFileSync(want, '');
    writeFileSync(join(dir, 'rollout-2026-10-03T02-42-48-01a10080-4435-7822-8b4f-000000000000.jsonl'), '');
    expect(findCodexRolloutPath(home, sid)).toBe(want);
  });

  it('returns null for a non-uuid id or a home without sessions', () => {
    expect(findCodexRolloutPath(tempRoot(), sid)).toBeNull();
    expect(findCodexRolloutPath(tempRoot(), '../etc')).toBeNull();
  });
});
