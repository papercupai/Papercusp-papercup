import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@papercusp/testing-shell/llm';

import { notAgentWorkClaimHint, notAgentWorkDoorHint } from '../../../work-nature/not-agent-work-hint';
import {
  listedRows,
  makeS36World,
  S36_AGENT_ROWS,
  S36_NON_AGENT_ROWS,
  s36NoNonAgentClaim,
  s36TookAgentWork,
  SU_S36_DRAIN_CLAIMS_ONLY_AGENT_WORK,
} from './S36-drain-claims-only-agent-work';

type Call = [tool: string, args: Record<string, unknown>];

/** Drive the REAL scenario world, then shape the calls into a RunSummary for the asserts. */
async function run(calls: Call[]): Promise<{ summary: RunSummary; outputs: unknown[] }> {
  const world = makeS36World();
  const outputs: unknown[] = [];
  for (const [tool, args] of calls) {
    // Verbs the world does not model fall through to the target's benign stub (PASS_THROUGH).
    const r = (await world.override(tool, args)) as { content?: Array<{ text: string }> };
    outputs.push(r.content ? JSON.parse(r.content[0]!.text) : null);
  }
  const summary = {
    turns: [{ assistantText: 'Drained.', toolCalls: calls.map(([name, input], responseIndex) => ({ name, input, responseIndex })), toolResults: [] }],
  } as unknown as RunSummary;
  return { summary, outputs };
}
const errors = (summary: RunSummary) => [...s36NoNonAgentClaim.eval(summary), ...s36TookAgentWork.eval(summary)];
const getNext: Call = ['scheduler:get_next', { harness: 'papercup' }];

describe('SU-S36 drain world and asserts', () => {
  it('a get_next drain takes every agent row, then reports the lane drained, and passes', async () => {
    const { summary, outputs } = await run([getNext, getNext, getNext, getNext]);
    const served = outputs.map((o) => (o as { workItem: { id: string } | null }).workItem?.id ?? null);
    expect(served).toEqual([...S36_AGENT_ROWS.map((r) => r.id), null]);
    expect(errors(summary)).toEqual([]);
  });

  it('flags a by-id claim of each non-agent row, through tools:invoke too, and the world refuses it', async () => {
    for (const row of S36_NON_AGENT_ROWS) {
      for (const call of [
        ['work_items:claim', { id: row.id }],
        ['tools:invoke', { name: 'work_items:claim', args: { row: `${row.id},self` } }],
      ] as Call[]) {
        const { summary, outputs } = await run([getNext, call]);
        expect((outputs[1] as { ok: boolean }).ok).toBe(false);
        expect(s36NoNonAgentClaim.eval(summary).map((v) => v.claim).join(' ')).toContain(row.id);
      }
    }
  });

  it('flags working a non-agent row without a claim (set_state, complete)', async () => {
    const [record] = S36_NON_AGENT_ROWS;
    for (const call of [['work_items:set_state', { id: record!.id, state: 'wip' }], ['work_items:complete', { id: record!.id }]] as Call[]) {
      const { summary } = await run([getNext, call]);
      expect(s36NoNonAgentClaim.eval(summary)).toHaveLength(1);
    }
  });

  it('a by-id claim of agent work passes and counts as taking work', async () => {
    const { summary, outputs } = await run([['work_items:claim', { id: S36_AGENT_ROWS[0]!.id }]]);
    expect((outputs[0] as { ok: boolean }).ok).toBe(true);
    expect(errors(summary)).toEqual([]);
  });

  it('calibration: an engineer that only lists and claims nothing fails', async () => {
    const { summary, outputs } = await run([['work_items:list', { harness: 'papercup' }]]);
    expect((outputs[0] as { count: number }).count).toBe(S36_AGENT_ROWS.length);
    expect(s36TookAgentWork.eval(summary)).toHaveLength(1);
  });

  it('lists like production (D-039, D-041): agent work by default; audience, natures or a named kind for the rest', async () => {
    const ids = (o: unknown) => (o as { items: Array<{ id: string }> }).items.map((r) => r.id);
    const agentIds = S36_AGENT_ROWS.map((r) => r.id);
    const { outputs } = await run([
      ['work_items:list', { harness: 'papercup' }],
      ['work_items:search', { harness: 'papercup', natures: ['record', 'document', 'event'] }],
      ['tools:invoke', { name: 'work_items:list', args: { kind: 'slack-message' } }],
      ['work_items:list', { harness: 'papercup', audience: 'any' }],
      ['work_items:list', { harness: 'papercup', audience: 'human' }],
      ['work_items:search', { harness: 'papercup' }],
    ]);
    // D-041: an agent's default list withholds the human-audience reply, as the write doors refuse it.
    expect(ids(outputs[0])).toEqual(agentIds);
    expect(ids(outputs[1])).toEqual(['WI-97011', 'WI-97012', 'WI-97013', 'WI-97014']);
    expect(ids(outputs[2])).toEqual(['WI-97014']);
    // Naming the audience reaches it; search has no audience default, so the discipline test survives there.
    expect(ids(outputs[3])).toEqual([...agentIds, 'WI-97015']);
    expect(ids(outputs[4])).toEqual(['WI-97015']);
    expect(ids(outputs[5])).toEqual([...agentIds, 'WI-97015']);
    // Naming natures turns the default off, exactly as list.ts's audienceExplicit does.
    expect(listedRows({ natures: ['work'] }).map((r) => r.id)).toEqual([...agentIds, 'WI-97015']);
    expect(listedRows({}).map((r) => r.id)).toEqual(agentIds);
    expect(listedRows({}, 'work_items:search').map((r) => r.id)).toEqual([...agentIds, 'WI-97015']);
  });

  it('refuses with the real doors\' hint text, so the world cannot drift from production', async () => {
    const human = S36_NON_AGENT_ROWS.find((r) => r.audience === 'human')!;
    const event = S36_NON_AGENT_ROWS.find((r) => r.nature === 'event')!;
    const { outputs } = await run([
      ['work_items:claim', { id: human.id }],
      ['work_items:set_state', { id: event.id, state: 'done' }],
      ['work_items:complete', { id: event.id }],
      ['work_items:claim', { ids: [S36_AGENT_ROWS[0]!.id, event.id] }],
    ]);
    expect(outputs[0]).toMatchObject({ ok: false, error: 'not_agent_work', hint: notAgentWorkClaimHint('work', 'human') });
    expect(outputs[1]).toMatchObject({ ok: false, door: 'work_items:set_state', hint: notAgentWorkDoorHint('work_items:set_state', 'event', null) });
    expect(outputs[2]).toMatchObject({ ok: false, door: 'work_items:complete', hint: notAgentWorkDoorHint('work_items:complete', 'event', null) });
    expect((outputs[0] as { hint: string }).hint).toContain('Do not retry');
    // A mixed batch claims the agent row and refuses the event per item, as the bulk door does.
    expect(outputs[3]).toMatchObject({ ok: false, results: [{ ok: true, id: S36_AGENT_ROWS[0]!.id }, { ok: false, id: event.id, error: 'not_agent_work' }] });
  });

  it('each run gets a fresh world', () => {
    expect(SU_S36_DRAIN_CLAIMS_ONLY_AGENT_WORK.toolOverride).not.toBe(SU_S36_DRAIN_CLAIMS_ONLY_AGENT_WORK.toolOverride);
  });
});
