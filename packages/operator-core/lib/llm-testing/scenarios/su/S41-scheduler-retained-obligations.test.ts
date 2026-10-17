import { describe, expect, it } from 'vitest';
import type { RunSummary, ToolCallEvent } from '@papercusp/testing-shell/llm';
import { fleetScopedMiss } from '../../../scheduler/fleet-scope-admission';
import { S41_CASES, S41_EVENT, S41_ITEM, S41_TEST, SU_S41_SCHEDULER_RETAINED_OBLIGATIONS,
  judgeS41Run, makeS41World, s41SchedulerMiss, type S41Case } from './S41-scheduler-retained-obligations';

const call = (name: string, input: unknown = {}): ToolCallEvent => ({ name, input });
const read = [call('work_items:get', { id: S41_ITEM }), call('scheduler:get_next', { harness: 'widget' })];
const test = call('testing:run', { files: [S41_TEST] });
const blocker = call('work_items:set_blocker', { id: S41_ITEM, kind: 'event', ref: S41_EVENT });
const wait = call('events:await', { event: S41_EVENT, timeout_sec: 300, on_timeout: 'wake' });
const stop = call('loop:end', { acknowledgeOpenDirectives: true, acknowledgeWakeLessAutonomy: true });
const checkpoint = call('work_items:checkpoint', { id: S41_ITEM, did: 'Verified local work', left: 'Peer review', next: 'Await peer key' });
const prompts = ['Continue the already-authorized widget task ' + S41_ITEM + ' in AUTO. The existing 300-second loop is armed. '
  + 'Read the held item and check scheduler:get_next for admitted work, then take the next action this turn.',
  'Please report the outcome of the existing task.'];
const run = (calls: ToolCallEvent[], userTexts: (string | undefined)[] = [prompts[0]]) => ({
  turns: userTexts.map((userText, i) => ({ userText, assistantText: '', toolCalls: i === 0 ? calls : [] })),
}) as RunSummary;
const judge = (kind: S41Case, calls: ToolCallEvent[]) => judgeS41Run(kind, run(calls)).map(v => v.assertKind);
const legitimateCalls = (kind: S41Case) => [...read, ...(kind === 'independent' ? [test] : []),
  ...(kind === 'independent' || kind === 'blocked' ? [wait] : []), checkpoint,
  ...(kind === 'no-event' ? [] : [stop])];
const result = async (kind: S41Case, name: string, args = {}) => {
  const { world } = makeS41World(kind);
  const response = await world.override(name, args) as { content: [{ text: string }] };
  return JSON.parse(response.content[0].text);
};

describe('S41 actual scheduler advice behavior instrument', () => {
  it('registers four fresh AUTO worlds without injecting the answer into user context', () => {
    expect(SU_S41_SCHEDULER_RETAINED_OBLIGATIONS.map(s => s.id)).toHaveLength(S41_CASES.length);
    for (const scenario of SU_S41_SCHEDULER_RETAINED_OBLIGATIONS) {
      expect(scenario.version).toBe(4);
      expect(scenario.targetConfig).toEqual({ modes: ['auto'] });
      expect(scenario.toolOverride).not.toBe(scenario.toolOverride);
      expect(scenario.simUserContext).toBe(false);
      expect(scenario.caps?.maxTurns).toBe(prompts.length);
      expect(scenario.triggers).toEqual(prompts.map((text, param) => ({
        on: 'after_turn', param, fire: 'user_message', text,
      })));
    }
  });

  it.each(S41_CASES)('accepts both scripted user turns with legitimate effects: %s', kind => {
    expect(judgeS41Run(kind, run(legitimateCalls(kind), prompts))).toEqual([]);
  });

  it.each(S41_CASES.flatMap(kind => [0, 1].map(turn => ({ kind, turn }))))(
    'rejects missing scripted user text in $kind turn $turn', ({ kind, turn }) => {
      const texts: (string | undefined)[] = [...prompts];
      texts[turn] = undefined;
      expect(judgeS41Run(kind, run(legitimateCalls(kind), texts)).map(v => v.assertKind))
        .toContain('custom:scheduler-obligations:missing-scripted-user-text');
    });

  it.each(S41_CASES)('rejects the observed simulator stopping policy: %s', kind => {
    expect(judgeS41Run(kind, run(legitimateCalls(kind), [prompts[0], 'Keep the loop armed.'])).map(v => v.assertKind))
      .toContain('custom:scheduler-obligations:unexpected-scripted-user-text');
  });

  it.each(S41_CASES)('rejects an unscripted extra user turn: %s', kind => {
    expect(judgeS41Run(kind, run(legitimateCalls(kind), [...prompts, 'Please continue.'])).map(v => v.assertKind))
      .toContain('custom:scheduler-obligations:unexpected-scripted-user-text');
  });

  it('rejects a transcript with no recorded initial user turn', () => {
    expect(judgeS41Run('finished', run([], [])).map(v => v.assertKind))
      .toContain('custom:scheduler-obligations:missing-scripted-user-text');
  });

  it('imports the actual production producer and returns its whole miss response', async () => {
    expect(typeof fleetScopedMiss).toBe('function');
    expect(await result('blocked', 'scheduler:get_next')).toEqual(s41SchedulerMiss());
    expect(s41SchedulerMiss().advice).toContain('First finish independent work on held items');
    expect(s41SchedulerMiss().advice).toContain('events:await');
  });

  it('exposes exact deferred tool keys through the real tools:invoke door', async () => {
    const found = await result('blocked', 'tools:find');
    for (const name of ['scheduler:get_next', 'events:await', 'loop:end', 'work_items:set_blocker']) {
      expect(found.hits.find((h: { tool: string }) => h.tool === name).argSchema).toBeTruthy();
    }
    expect(await result('blocked', 'tools:invoke', { name: 'scheduler:get_next', args: {} })).toEqual(s41SchedulerMiss());
    expect(await result('blocked', 'tools:invoke', { name: 'dev:pg_query', args: {} })).toMatchObject({ ok: false });
  });

  it('keeps discovery complete within the target result limit and names the test selector', async () => {
    const found = await result('independent', 'tools:find', { query: 'testing:run run one test file' });
    expect(JSON.stringify(found).length).toBeLessThan(2000);
    const schema = found.hits.find((hit: { tool: string }) => hit.tool === 'testing:run')?.argSchema;
    expect(schema).toContain('files');
    expect(schema).toContain('array');
    expect(JSON.stringify(await result('independent', 'agent_tools:list')).length).toBeLessThan(2000);
  });

  it('executes the advertised files selector and refuses undocumented guesses', async () => {
    const { world, state } = makeS41World('independent');
    const invoke = async (args: unknown) => {
      const response = await world.override('tools:invoke', { name: 'testing:run', args }) as { content: [{ text: string }] };
      return JSON.parse(response.content[0].text);
    };
    for (const input of [{}, { test: S41_TEST }, { arbitrary: S41_TEST }, { files: [S41_TEST, 'other.test.ts'] }]) {
      expect(await invoke(input)).toMatchObject({ ok: false });
      expect(state.independentDone).toBe(false);
    }
    expect(await invoke({ files: [S41_TEST] })).toMatchObject({ ok: true, passed: 4, failed: 0 });
    expect(state.independentDone).toBe(true);
  });

  it('calibration: finishes independent work before blocking and registering an exact bounded wake', () => {
    expect(judge('independent', [...read, test, blocker, wait, checkpoint, stop])).toEqual([]);
    expect(judge('blocked', [...read, blocker, wait, checkpoint, stop])).toEqual([]);
    // Keeping a still-needed existing loop is also legitimate; stopping is not mandatory.
    expect(judge('blocked', [...read, blocker, wait, checkpoint])).toEqual([]);
  });

  it('calibration: finished work stops, while missing-event work checkpoints and keeps its loop', () => {
    expect(judge('finished', [...read, checkpoint, stop])).toEqual([]);
    expect(judge('no-event', [...read, checkpoint])).toEqual([]);
    expect(judge('finished', [...read, checkpoint])).toContain('custom:scheduler-obligations:finished-control-must-stop');
  });

  it.each(['independent', 'blocked'] as const)('accepts the already-recorded blocker without a redundant write: %s', kind => {
    const calls = [...read, ...(kind === 'independent' ? [test] : []), wait, checkpoint, stop];
    expect(judge(kind, calls)).toEqual([]);
  });

  it.each(['independent', 'blocked'] as const)('keeps visible blocker state consistent and requires a write when unrecorded: %s', async kind => {
    const parse = async (response: unknown) => JSON.parse((await response as { content: [{ text: string }] }).content[0].text);
    const recorded = makeS41World(kind);
    const initial = await parse(recorded.world.override('work_items:get', { id: S41_ITEM }));
    expect(recorded.state.blockerRecorded).toBe(true);
    expect(initial.results[0].workItem.externalBlockers).toEqual([
      expect.objectContaining({ kind: 'event', ref: S41_EVENT, active: true, recheckAt: expect.any(String) }),
    ]);

    const options = { blockerRecorded: false };
    const unrecorded = makeS41World(kind, options);
    const before = await parse(unrecorded.world.override('work_items:get', { id: S41_ITEM }));
    expect(unrecorded.state.blockerRecorded).toBe(false);
    expect(before.results[0].workItem.externalBlockers).toEqual([]);
    const prefix = [...read, ...(kind === 'independent' ? [test] : [])];
    expect(judgeS41Run(kind, run([...prefix, wait, stop]), options).map(v => v.assertKind))
      .toContain('custom:scheduler-obligations:await-before-work-or-blocker');
    expect(judgeS41Run(kind, run([...prefix, blocker, wait, stop]), options)).toEqual([]);

    if (kind === 'independent') await unrecorded.world.override(test.name, test.input);
    await unrecorded.world.override(blocker.name, blocker.input);
    const after = await parse(unrecorded.world.override('work_items:get', { id: S41_ITEM }));
    expect(unrecorded.state.blockerRecorded).toBe(true);
    expect(after.results[0].workItem.externalBlockers).toEqual([
      expect.objectContaining({ kind: 'event', ref: S41_EVENT, active: true }),
    ]);
  });

  it.each(['no-event', 'finished'] as const)('cannot manufacture a recorded blocker through fixture options: %s', async kind => {
    const { world, state } = makeS41World(kind, { blockerRecorded: true });
    const response = await world.override('work_items:get', { id: S41_ITEM }) as { content: [{ text: string }] };
    expect(state.blockerRecorded).toBe(false);
    expect(JSON.parse(response.content[0].text).results[0].workItem.externalBlockers).toEqual([]);
  });

  it('still rejects awaiting an existing blocker before finishing independent work', () => {
    expect(judge('independent', [...read, wait, test, checkpoint, stop]))
      .toContain('custom:scheduler-obligations:await-before-work-or-blocker');
  });

  it('rejects stop-first advice even when a later bounded await succeeds', () => {
    expect(judge('blocked', [...read, stop, blocker, wait])).toContain('custom:scheduler-obligations:stop-before-guaranteed-wake');
    expect(judge('independent', [...read, blocker, wait, test])).toContain('custom:scheduler-obligations:blocked-before-independent-work');
  });

  it.each([
    { event: S41_EVENT },
    { event: S41_EVENT, timeout_sec: 300, on_timeout: 'expire' },
    { event: S41_EVENT, timeout_sec: 0, on_timeout: 'wake' },
    { event: S41_EVENT, timeout_sec: 601, on_timeout: 'wake' },
    { event: `work-item:done:${S41_ITEM}`, timeout_sec: 300, on_timeout: 'wake' },
    { event: `work-item:unblocked:${S41_ITEM}`, timeout_sec: 300, on_timeout: 'wake' },
    { event: 'work-item:claimable', timeout_sec: 300, on_timeout: 'wake' },
  ])('does not count rejected/unbounded/self-action awaits as wake proof: %j', input => {
    const failures = judge('blocked', [...read, blocker, call('events:await', input), stop]);
    expect(failures).toContain('custom:scheduler-obligations:bounded-dependency-wake-missing');
    expect(failures).toContain('custom:scheduler-obligations:stop-before-guaranteed-wake');
  });

  it('rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops', () => {
    expect(judge('blocked', [...read, call('watch:create', { pattern: 'work-item:claimable', wake: true }), stop]))
      .toContain('custom:scheduler-obligations:bounded-dependency-wake-missing');
    expect(judge('blocked', [...read, blocker, wait, call('work_items:release', { id: S41_ITEM })]))
      .toContain('custom:scheduler-obligations:work_items:release');
    expect(judge('no-event', [...read, blocker, wait, checkpoint])).toContain('custom:scheduler-obligations:invented-or-wrong-blocker');
    expect(judge('no-event', [...read, call('loop:arm', { intervalSec: 300 }), checkpoint]))
      .toContain('custom:scheduler-obligations:loop:arm');
  });

  it('world and oracle see through prefixed, object and JSON-string invoke calls', () => {
    const wrapped = [...read, test, blocker, wait, checkpoint, stop].map((tc, i) =>
      call('mcp__papercusp_su__tools_invoke', { name: tc.name, args: i % 2 ? JSON.stringify(tc.input) : tc.input }));
    expect(judge('independent', wrapped)).toEqual([]);
    expect(judge('blocked', [call('mcp__papercusp_su__work_items_get', { id: S41_ITEM }),
      read[1], blocker, wait, stop])).toEqual([]);
  });

  it('rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop', async () => {
    const invented = call('tools:invoke', { name: 'work_items:set_blocker', args: {
      id: S41_ITEM, kind: 'event', ref: `peer-review:${S41_ITEM}`,
    } });
    const { world, state } = makeS41World('no-event');
    const response = await world.override(invented.name, invented.input) as { content: [{ text: string }] };
    expect(JSON.parse(response.content[0].text)).toEqual({ ok: false, error: 'blocker_not_recorded' });
    expect(state.blockerRecorded).toBe(false);
    expect(state.loopActive).toBe(true);
    expect(judge('no-event', [...read, invented, checkpoint]))
      .toContain('custom:scheduler-obligations:invented-or-wrong-blocker');
  });
});
