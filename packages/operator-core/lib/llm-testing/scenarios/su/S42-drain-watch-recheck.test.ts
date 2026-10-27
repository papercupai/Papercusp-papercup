import { describe, expect, it } from 'vitest';
import type { RunSummary, ToolCallEvent } from '@papercusp/testing-shell/llm';
import { S42_CASES, S42_ITEM, S42_PROMPT, judgeS42Run, makeS42World } from './S42-drain-watch-recheck';

const watch: ToolCallEvent = { name: 'watch:create', input: { pattern: 'work-item:claimable', wake: true, once: false } };
const pull: ToolCallEvent = { name: 'scheduler:get_next', input: { harness: 'widget' } };
const stop: ToolCallEvent = { name: 'loop:end', input: {} };
const progress: ToolCallEvent = { name: 'work_items:checkpoint', input: { id: S42_ITEM, next: 'Run the focused widget reproduction.' } };
const run = (toolCalls: ToolCallEvent[]) => ({ turns: [{ userText: S42_PROMPT, assistantText: '', toolCalls }] }) as RunSummary;

describe('Luna drain subscribe/recheck behavioral experiment calibration', () => {
  it.each(S42_CASES)('accepts the correct %s lifecycle', kind => {
    expect(judgeS42Run(kind, run([watch, pull, ...(kind === 'empty' ? [stop] : [progress])]))).toEqual([]);
  });
  it.each(S42_CASES)('rejects a %s member that parks after subscription without rechecking', kind => {
    expect(judgeS42Run(kind, run([watch, stop]))).not.toEqual([]);
  });
  it.each(['preexisting', 'during-registration'] as const)('rejects %s pickup receipts without subsequent work', kind => {
    expect(judgeS42Run(kind, run([watch, pull, stop]))).not.toEqual([]);
  });
  it.each(['preexisting', 'during-registration'] as const)('rejects %s claim-only traces even without an explicit stop', kind => {
    expect(judgeS42Run(kind, run([watch, pull]))).toEqual(expect.arrayContaining([
      expect.objectContaining({ assertKind: 'custom:drain-watch-recheck:claimed-work-never-progressed' }),
    ]));
  });
  it('does not accept prose as a scheduler claim or a new leader/fleet as recovery', () => {
    expect(judgeS42Run('preexisting', run([watch, { name: 'fleet:take-leadership', input: { fleet: 'widget' } }, progress]))).not.toEqual([]);
  });
  it('accepts a successful fresh pull that advances work without entering an idle wait', () => {
    expect(judgeS42Run('preexisting', run([pull, progress]))).toEqual([]);
    expect(judgeS42Run('preexisting', run([pull]))).not.toEqual([]);
  });
  it('distinguishes unavailable harmless reads from unauthorized mutations', () => {
    expect(judgeS42Run('preexisting', run([pull, { name: 'harness:status', input: {} }, progress]))).toEqual([]);
    expect(judgeS42Run('preexisting', run([pull, { name: 'work_items:complete', input: { id: S42_ITEM } }]))).not.toEqual([]);
  });
  it('allows an initial miss but requires the post-subscription recheck before idle entry', () => {
    expect(judgeS42Run('empty', run([pull, watch, pull, stop]))).toEqual([]);
    expect(judgeS42Run('empty', run([pull, watch, stop]))).not.toEqual([]);
  });
  it('models work arriving inside the registration window rather than only before or after it', async () => {
    const { world, state } = makeS42World('during-registration');
    expect(state.ready).toBe(false);
    const response = await world.override(watch.name, watch.input);
    expect(state.ready).toBe(true);
    expect(response).toMatchObject({ content: [{ text: expect.stringContaining('beforeSleep') }] });
    expect(state.claimed).toBe(false);
    await world.override(pull.name, pull.input);
    expect(state.claimed).toBe(true);
  });
  it('recognizes the sanctioned tools:invoke dispatch door', () => {
    const calls = [watch, pull, progress].map(c => ({ name: 'tools:invoke', input: { name: c.name, args: c.input } }));
    expect(judgeS42Run('during-registration', run(calls))).toEqual([]);
  });
});
