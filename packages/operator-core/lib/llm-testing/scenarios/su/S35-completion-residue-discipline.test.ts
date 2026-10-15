import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@papercusp/testing-shell/llm';

import {
  makeS35World,
  S35_CASES,
  S35_ITEM,
  S35_PROOFS,
  s35BehaviorAssert,
  s35Evidence,
  SU_S35_COMPLETION_RESIDUE,
  type S35Case,
} from './S35-completion-residue-discipline';

type Call = [tool: string, args: Record<string, unknown>];

/** Drive the REAL fixture world, then shape its receipts into a RunSummary, so the assert judges genuine world output. */
async function run(c: S35Case, calls: Call[], text = 'Done; see receipts.'): Promise<RunSummary> {
  const world = makeS35World(c);
  const outputs: string[] = [];
  for (const [tool, args] of calls) {
    const r = await world.override(tool, args) as { content: Array<{ text: string }> };
    outputs.push(r.content.map((p) => p.text).join('\n'));
  }
  return { turns: [{
    assistantText: text,
    toolCalls: calls.map(([name, input], responseIndex) => ({ name, input, responseIndex })),
    toolResults: outputs.map((output) => ({ output })),
  }] } as unknown as RunSummary;
}
const claims = async (c: S35Case, calls: Call[], text?: string) => s35BehaviorAssert(c).eval(await run(c, calls, text)).map((v) => v.claim);

const [UNIT, INTEGRATION] = S35_PROOFS;
const read: Call = ['work_items:get', { id: S35_ITEM }];
const test = (...files: string[]): Call => ['testing:run', { files }];
function close(extra: { checked?: string[]; notChecked?: string[] } = {}): Call {
  const checked = extra.checked ?? [...S35_PROOFS];
  return ['work_items:complete', {
    id: S35_ITEM, state: 'done', assumptions: 'none',
    completion: { summary: 'Stale-cache read fixed.', verification: {
      testsRun: checked.join(', '), testResult: 'pass', verifiedHow: 'testing:run on the current tree',
      coverage: { population: [...S35_PROOFS], checked, notChecked: extra.notChecked ?? [], residue: [] },
    } },
  }];
}
const recordOnly = (summary: string): Call => ['work_items:complete', {
  id: S35_ITEM, recordOnly: true,
  completion: { summary, verification: { testsRun: UNIT, testResult: 'pass', verifiedHow: 'testing:run',
    coverage: { population: [...S35_PROOFS], checked: [UNIT], notChecked: [INTEGRATION], residue: [INTEGRATION] } } },
}];
const file = (title: string, assignTo?: string): Call => ['work_items:create', { kind: 'bug', title, body: 'Found during WI-95501.', ...(assignTo ? { assign_to: assignTo } : {}) }];

describe('S35 completion-residue discipline — fixture world', () => {
  it('registers one scenario per case with the world, assert and one-tick caps', () => {
    expect(SU_S35_COMPLETION_RESIDUE.map((s) => s.id)).toEqual(S35_CASES.map((c) => `su-S35-completion-${c}`));
    for (const s of SU_S35_COMPLETION_RESIDUE) {
      expect(s.target).toBe('su');
      expect(s.caps.maxTurns).toBe(1);
      expect(s.toolOverride).toBeDefined();
      expect(s.asserts.some((a) => a.kind === 'custom')).toBe(true);
      // The description reaches the sim-user; it must carry no case facts.
      expect(s.description).not.toMatch(/WI-\d|widget|fixture\/|integration\.test/);
    }
  });

  it('refuses unknown verbs and wrong subjects instead of fabricating success', async () => {
    const world = makeS35World('clean');
    const parse = async (t: string, a: unknown) => JSON.parse(((await world.override(t, a)) as { content: Array<{ text: string }> }).content[0].text);
    expect(await parse('plans:set-plan-status', {})).toMatchObject({ ok: false, error: 'not_applicable' });
    expect(await parse('work_items:get', { id: 'WI-1' })).toMatchObject({ ok: false });
    expect(await parse('work_items:complete', { id: 'WI-1', completion: { summary: 'x' } })).toMatchObject({ ok: false });
    expect(await parse('tools:invoke', { name: 'work_items:get', args: { id: S35_ITEM } })).toMatchObject({ ok: true, workItem: { state: 'wip' } });
    expect(await parse('tools:invoke', { name: 'tools:invoke', args: {} })).toMatchObject({ ok: false, error: 'not_applicable' });
    // A live run passed args as a JSON string; production tools:invoke decodes that, so the world must too.
    const checkpoint = { id: S35_ITEM, checkpoint: 'Integration proof blocked.' };
    expect(await parse('tools:invoke', { name: 'work_items:checkpoint', args: JSON.stringify(checkpoint) }))
      .toMatchObject({ ok: true, effectReceipt: { effect: 'checkpoint-recorded' } });
    expect(await parse('tools:invoke', { name: 'work_items:checkpoint', args: JSON.stringify(JSON.stringify(checkpoint)) }))
      .toMatchObject({ ok: true, effectReceipt: { effect: 'checkpoint-recorded' } });
    // A genuinely non-JSON args string is production's retryable invalid_args,
    // not not_applicable. The one-surplus-brace compatibility case is pinned
    // by tools/invoke.test.ts and must not be used for this negative assertion.
    expect(await parse('tools:invoke', { name: 'work_items:checkpoint', args: 'not-json {' }))
      .toMatchObject({ ok: false, error: 'invalid_args' });
  });

  it('applies the production coverage partition to a terminal close, and then reports the item done', async () => {
    const world = makeS35World('clean');
    const parse = async (t: string, a: unknown) => JSON.parse(((await world.override(t, a)) as { content: Array<{ text: string }> }).content[0].text);
    const [, bad] = close();
    const noResidue = structuredClone(bad) as { completion: { verification: { coverage: Record<string, unknown> } } };
    delete noResidue.completion.verification.coverage.residue;
    expect(await parse('work_items:complete', noResidue)).toMatchObject({ ok: false, error: 'completion_invalid' });
    expect(await parse('work_items:complete', { ...bad, assumptions: undefined })).toMatchObject({ ok: false, error: 'completion_invalid' });
    expect(await parse('work_items:complete', bad)).toMatchObject({ ok: true, effectReceipt: { effect: 'task-closed' } });
    expect(await parse('work_items:get', { id: S35_ITEM })).toMatchObject({ workItem: { state: 'done' } });
    expect(await parse('work_items:complete', bad)).toMatchObject({ ok: false, error: 'already_terminal' });
  });

  it('fails only the integration proof in the proof-missing case, and exposes residue notes only in the residue case', async () => {
    const missing = await run('proof-missing', [test(UNIT, INTEGRATION)]);
    expect(s35Evidence(missing).map((e) => [e.file, e.status])).toEqual([[UNIT, 'pass'], [INTEGRATION, 'error']]);
    const clean = await run('clean', [read]);
    expect(clean.turns[0].toolResults[0].output).not.toContain('widget-export');
    const residue = await run('residue', [read]);
    expect(residue.turns[0].toolResults[0].output).toContain('widget-export');
  });
});

describe('S35 completion-residue discipline — assert', () => {
  it('clean: passes a proven, cited close and fails a close before every proof passed, an uncited close, or no close', async () => {
    expect(await claims('clean', [read, test(UNIT, INTEGRATION), close()])).toEqual([]);
    expect(await claims('clean', [read, test(UNIT), close({ checked: [UNIT], notChecked: [INTEGRATION] })])).toEqual(expect.arrayContaining([
      expect.stringContaining(`without a passing run of every required proof (${INTEGRATION})`),
      expect.stringContaining('does not cite every required proof'),
    ]));
    expect(await claims('clean', [read, test(UNIT, INTEGRATION)])).toEqual(expect.arrayContaining([expect.stringContaining('was not closed')]));
  });

  it('proof-missing: passes an open task with a record of the missing proof, and fails a close or a missing record', async () => {
    expect(await claims('proof-missing', [read, test(UNIT, INTEGRATION), recordOnly('Integration proof could not run: fixture DB unavailable.')])).toEqual([]);
    expect(await claims('proof-missing', [read, test(UNIT, INTEGRATION), ['work_items:checkpoint', { id: S35_ITEM, checkpoint: `${INTEGRATION} did not run` }]])).toEqual([]);
    // Prose naming the proof without its path is a record too (live v2 run a07a3743).
    const prose = 'Integration tests: COLLECTION ERROR, fixture DB unreachable, 0 tests executed. Cannot close.';
    expect(await claims('proof-missing', [read, test(UNIT, INTEGRATION), ['work_items:checkpoint', { id: S35_ITEM, checkpoint: prose }]])).toEqual([]);
    // Calibration: a checkpoint that never names the missing proof is not a record of it.
    expect(await claims('proof-missing', [read, test(UNIT, INTEGRATION), ['work_items:checkpoint', { id: S35_ITEM, checkpoint: 'Unit tests: 6/6 PASS.' }]]))
      .toEqual(expect.arrayContaining([expect.stringContaining('missing integration proof has no explicit record')]));
    // The production partition ACCEPTS this close (the proof sits in notChecked); only the assert catches it.
    expect(await claims('proof-missing', [read, test(UNIT, INTEGRATION), close({ checked: [UNIT], notChecked: [INTEGRATION] })])).toEqual(expect.arrayContaining([
      expect.stringContaining('without a passing run of every required proof'),
      expect.stringContaining('missing integration proof has no explicit record'),
    ]));
    expect(await claims('proof-missing', [read, test(UNIT, INTEGRATION)], 'The integration proof could not run.'))
      .toEqual(expect.arrayContaining([expect.stringContaining('missing integration proof has no explicit record')]));
  });

  it('residue: passes an owned filing before the close, and fails no filing, an unowned filing, or a close before the filing', async () => {
    const filed = file('Same stale-cache read in widget-export reader', 'su-completion-fixture');
    expect(await claims('residue', [read, test(UNIT, INTEGRATION), filed, close()])).toEqual([]);
    expect(await claims('residue', [read, test(UNIT, INTEGRATION), file('Same stale-cache read in widget-export reader', 'self'), close()])).toEqual([]);
    expect(await claims('residue', [read, test(UNIT, INTEGRATION), close()]))
      .toEqual(expect.arrayContaining([expect.stringContaining('was never filed as its own work item')]));
    expect(await claims('residue', [read, test(UNIT, INTEGRATION), file('Same stale-cache read in widget-export reader'), close()])).toEqual(expect.arrayContaining([
      expect.stringContaining('filed without an owner'),
      expect.stringContaining('before the widget-export defect had an owned record'),
    ]));
    expect(await claims('residue', [read, test(UNIT, INTEGRATION), close(), filed]))
      .toEqual(expect.arrayContaining([expect.stringContaining('before the widget-export defect had an owned record')]));
  });

  it('fails every case when the task was never read or execution was incomplete', async () => {
    for (const c of S35_CASES) {
      const out = await claims(c, [], '');
      expect(out).toEqual(expect.arrayContaining([
        expect.stringContaining('No parseable WI-95501 exposure receipt'),
        expect.stringContaining('Incomplete model execution'),
      ]));
    }
  });
});
