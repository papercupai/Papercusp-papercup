/**
 * Unit tests for `./_asserts.ts` — pure `RunSummary → Violation[]` builders.
 *
 * Regression coverage for EI-7923/WI-3229: S23/S24/S25 live re-runs showed the
 * model's ACTUAL merged output was correct, but two assert-authoring bugs
 * false-positived:
 *   1. `assertTextForbidsInTurnAfter`'s `sectionStart` anchor must match how
 *      models actually phrase the current-list header, or its anchor-not-found
 *      fallback scans the WHOLE turn and catches a legitimate "what changed"
 *      narration that correctly mentions the removed item's old title.
 *   2. A hardcoded hard `turnIdx` (`assertTextRequiresInTurn`/
 *      `assertTextForbidsInTurn`) false-fails when the model legitimately takes
 *      an extra turn (e.g. a clarifying question after compaction) before its
 *      substantive answer — `assertTextRequiresFromTurn`/
 *      `assertTextForbidsFromTurn` check a range instead of one fixed index.
 *
 * The `RunSummary`/`TurnResult` builders below construct minimal, fully-valid
 * fixtures — the builders read only `run.turns`, but every required field of
 * the real types is supplied so the fixtures are genuine, not casts.
 */

import { describe, it, expect } from 'vitest';
import type { RunSummary, TurnResult } from '@papercusp/testing-shell/llm';

import {
  assertCodeRunOrBulkOrSingleTurnFanout,
  assertToolCallCountAtLeast,
  assertToolCallCountAtMost,
  assertToolCalled,
  assertToolCalledWithin,
  assertToolCalledWithArrayArg,
  assertToolNotCalled,
  assertToolGroupWithStringArg,
  assertRequestedPlanItemsClaimed,
  assertToolSequence,
  assertTextForbidsAffirmed,
  assertTextForbidsInTurnAfter,
  assertTextForbidsInTurnAfterUnlessLine,
  assertTextForbidsFromTurn,
  assertTextRequiresFromTurn,
} from './_asserts';

function mkTurn(partial: Partial<TurnResult> = {}): TurnResult {
  return {
    assistantText: '',
    toolCalls: [],
    toolResults: [],
    cards: [],
    controlTags: [],
    costUsd: 0,
    latencyMs: 0,
    finishReason: 'done',
    rawSseTape: [],
    ...partial,
  };
}

function mkRun(turns: TurnResult[]): RunSummary {
  return {
    runId: 'r1',
    scenarioId: 's1',
    scenarioVersion: 1,
    scenarioTarget: 'su',
    identityHash: 'h',
    sutModel: 'sonnet',
    judgeModel: 'sonnet',
    personaId: 'p',
    personaTraits: {
      verbosity: 'normal',
      politeness: 'neutral',
      clarification: 'sometimes',
      goalClarity: 'precise',
      interrupts: false,
      modality: 'voice',
    },
    workspaceMode: 'isolated',
    transportMode: 'in-process',
    turns,
    toolInvocations: [],
    continueChainRows: [],
    totalCostUsd: 0,
    startedAt: new Date(0),
    finishedAt: new Date(0),
    finishReason: 'completed',
    capBreaches: [],
  };
}

const META = { name: 't', claim: 'c' };

describe('tools:invoke dispatch identity in su assertions', () => {
  const invoked = (name: string, args: Record<string, unknown>) =>
    ({ name: 'tools:invoke', input: { name, args } });
  const run = mkRun([mkTurn({ toolCalls: [invoked('docs:author', { harness: 'engineering' })] })]);

  it('sees the effective tool and its arguments in behavioral assertions', () => {
    expect(assertToolCalled(['docs:author'], META).eval(run)).toEqual([]);
    expect(assertToolCalledWithin(['docs:author'], 1, META).eval(run)).toEqual([]);
    expect(assertToolGroupWithStringArg(['docs'], 'harness', META).eval(run)).toEqual([]);
    expect(assertToolNotCalled(['docs:author'], META).eval(run)).toHaveLength(1);
  });

  it('still permits checks that intentionally assert use of the wrapper door', () => {
    expect(assertToolCalled(['tools:invoke'], META).eval(run)).toEqual([]);
    expect(assertToolNotCalled(['tools:invoke'], META).eval(run)).toHaveLength(1);
  });

  it('uses nested arguments for bulk and counts each dispatched call once', () => {
    const bulk = mkRun([mkTurn({ toolCalls: [
      invoked('work_items:get', { ids: ['a', 'b', 'c'] }),
    ] })]);
    expect(assertToolCalledWithArrayArg(['work_items:get'], 'ids', 3, META).eval(bulk)).toEqual([]);
    expect(assertCodeRunOrBulkOrSingleTurnFanout(['work_items:get'], 3, META).eval(bulk)).toEqual([]);
    expect(assertToolCallCountAtLeast(['work_items:get'], 1, META).eval(bulk)).toEqual([]);
    expect(assertToolCallCountAtMost(['work_items:get'], 0, META).eval(bulk)).toHaveLength(1);
  });

  it('counts only real nested plan claims and rejects malformed wrapper args', () => {
    const claims = mkRun([mkTurn({ toolCalls: [
      invoked('plan_items:claim', { plan: 'plan-1', item: 'P-001' }),
    ] })]);
    expect(assertRequestedPlanItemsClaimed('plan-1', ['P-001'], META).eval(claims)).toEqual([]);
    const invalid = mkRun([mkTurn({ toolCalls: [{ name: 'tools:invoke', input: { name: 'plan_items:claim', args: [] } }] })]);
    expect(assertRequestedPlanItemsClaimed('plan-1', ['P-001'], META).eval(invalid)).toHaveLength(1);
  });
});

describe('assertToolSequence', () => {
  const isWrite = (tc: { name: string }) => tc.name === 'capability:edit';
  const isRead = (tc: { name: string }) => tc.name === 'capability:read';
  const assertion = assertToolSequence(isWrite, isRead, META);

  it('requires verification after the action, including across turns', () => {
    expect(assertion.eval(mkRun([
      mkTurn({ toolCalls: [{ name: 'capability:edit', input: {} }] }),
      mkTurn({ toolCalls: [{ name: 'capability:read', input: {} }] }),
    ]))).toEqual([]);
  });

  it('rejects a read that happened only before the action', () => {
    expect(assertion.eval(mkRun([
      mkTurn({ toolCalls: [{ name: 'capability:read', input: {} }] }),
      mkTurn({ toolCalls: [{ name: 'capability:edit', input: {} }] }),
    ]))).toHaveLength(1);
  });
});

describe('assertToolCalledWithin', () => {
  const assertion = assertToolCalledWithin(['docs:author'], 2, META);

  it('passes when the tool is called in either allowed early turn', () => {
    expect(assertion.eval(mkRun([
      mkTurn(),
      mkTurn({ toolCalls: [{ name: 'docs:author', input: { slug: 'insight' } }] }),
    ]))).toEqual([]);
  });

  it('fails when the call is deferred beyond the allowed turn window', () => {
    expect(assertion.eval(mkRun([
      mkTurn(),
      mkTurn(),
      mkTurn({ toolCalls: [{ name: 'docs:author', input: { slug: 'late' } }] }),
    ]))).toHaveLength(1);
  });

  it('matches canonical names behind an MCP prefix', () => {
    expect(assertion.eval(mkRun([
      mkTurn({ toolCalls: [{ name: 'mcp__agentmcp__docs:author', input: { slug: 'prefixed' } }] }),
    ]))).toEqual([]);
  });
});

describe('assertTextForbidsInTurnAfter', () => {
  it('does NOT violate on a correct merged reply that narrates the removal before the anchor (EI-7923 regression)', () => {
    // The exact live-observed S23 phrasing: a "Removed: ... debounce" preamble,
    // then a "Current open work items" table WITHOUT the removed row.
    const run = mkRun([
      mkTurn(),
      mkTurn({
        assistantText:
          "Here's the updated list. Two changes since the last check:\n\n" +
          '- **Removed:** `WI-7002` — *Flaky harness-fs-watcher debounce* (no longer open)\n\n' +
          '**Current open work items (5 total):**\n\n' +
          '| ID | Title |\n|---|---|\n| WI-7001 | ... |\n',
      }),
    ]);
    const violations = assertTextForbidsInTurnAfter(
      /debounce/i,
      1,
      /current (open work items|full list|list)|updated (full )?list/i,
      META,
    ).eval(run);
    expect(violations).toEqual([]);
  });

  it('still catches a genuinely wrong merge (removed row present AFTER the anchor)', () => {
    const run = mkRun([
      mkTurn(),
      mkTurn({
        assistantText:
          '**Current open work items:**\n\n| ID | Title |\n|---|---|\n| WI-7002 | ...debounce... |\n',
      }),
    ]);
    const violations = assertTextForbidsInTurnAfter(
      /debounce/i,
      1,
      /current (open work items|full list|list)|updated (full )?list/i,
      META,
    ).eval(run);
    expect(violations).toHaveLength(1);
    expect(violations[0].assertKind).toBe('custom:t');
  });

  it('the OLD narrow anchor (regression fixture) false-positives on the same correct reply', () => {
    const run = mkRun([
      mkTurn(),
      mkTurn({
        assistantText:
          "Here's the updated list. Two changes since the last check:\n\n" +
          '- **Removed:** `WI-7002` — *Flaky harness-fs-watcher debounce* (no longer open)\n\n' +
          '**Current open work items (5 total):**\n\n' +
          '| ID | Title |\n|---|---|\n| WI-7001 | ... |\n',
      }),
    ]);
    // Old anchor never matches this phrasing -> falls back to whole-turn scan -> false violation.
    const violations = assertTextForbidsInTurnAfter(/debounce/i, 1, /updated full list|current list/i, META).eval(run);
    expect(violations).toHaveLength(1); // documents the bug this WI fixed
  });
});

describe('assertTextForbidsInTurnAfterUnlessLine', () => {
  const currentList = /(?:current|updated|full updated)\s+(?:(?:full|open)\s+)*(?:work items|list)/i;
  const visiblyRemoved = /~~|\b(?:removed|closed|dropped|gone|no longer)\b/i;
  const assertion = assertTextForbidsInTurnAfterUnlessLine(
    /debounce/i,
    1,
    currentList,
    visiblyRemoved,
    META,
  );

  it('allows the live struck-through row when the same line explicitly marks it removed', () => {
    const run = mkRun([
      mkTurn(),
      mkTurn({
        assistantText:
          "Here's the updated full list of open work items, with changes noted:\n\n" +
          '| ~~WI-7002~~ | ~~Flaky harness-fs-watcher debounce~~ | **Removed** |\n' +
          '| WI-7003 | Audit log drops NUL bytes | No change |\n' +
          '\n- WI-7002 debounce is gone from the open set.',
      }),
    ]);
    expect(assertion.eval(run)).toEqual([]);
  });

  it('recognizes the live reversed heading and ignores a removal in the preceding change summary', () => {
    const run = mkRun([
      mkTurn(),
      mkTurn({
        assistantText:
          '**Changes since last check:**\n- WI-7002 debounce — removed\n\n' +
          '**Full updated open work items:**\n| WI-7003 | Audit log drops NUL bytes |',
      }),
    ]);
    expect(assertion.eval(run)).toEqual([]);
  });

  it('still rejects an unmarked removed row in the current-list section', () => {
    const run = mkRun([
      mkTurn(),
      mkTurn({
        assistantText:
          '**Full updated open work items:**\n| WI-7002 | Flaky harness-fs-watcher debounce |\n',
      }),
    ]);
    expect(assertion.eval(run)).toHaveLength(1);
  });
});

describe('assertTextRequiresFromTurn', () => {
  it('passes when the correct answer lands one turn later than a fixed index would assume (EI-7923 S24 regression)', () => {
    const run = mkRun([
      mkTurn({ assistantText: 'Here are the 5 open work items: ...' }),
      mkTurn({ assistantText: 'Could you clarify what list you want?' }),
      mkTurn({ assistantText: 'Here is the current full list: ... Sandbox npm-install EROFS ...' }),
    ]);
    const violations = assertTextRequiresFromTurn(/EROFS/i, 1, META).eval(run);
    expect(violations).toEqual([]);
  });

  it('still violates when no turn from the start index onward has the required content', () => {
    const run = mkRun([mkTurn({ assistantText: 'ok' }), mkTurn({ assistantText: 'still nothing' })]);
    const violations = assertTextRequiresFromTurn(/EROFS/i, 1, META).eval(run);
    expect(violations).toHaveLength(1);
  });
});

describe('assertTextForbidsFromTurn', () => {
  it('violates if a banned value appears in ANY turn from the start index onward, not just the first', () => {
    const run = mkRun([
      mkTurn({ assistantText: 'ok' }),
      mkTurn({ assistantText: 'clarifying...' }),
      mkTurn({ assistantText: 'the list still has debounce in it' }),
    ]);
    const violations = assertTextForbidsFromTurn(/debounce/i, 1, META).eval(run);
    expect(violations).toHaveLength(1);
    expect(violations[0].evidenceTurnIdx).toBe(2);
  });

  it('passes when the banned value never appears from the start index onward', () => {
    const run = mkRun([
      mkTurn({ assistantText: 'debounce is mentioned only in turn 0, before the checked range' }),
      mkTurn({ assistantText: 'clean answer' }),
    ]);
    const violations = assertTextForbidsFromTurn(/debounce/i, 1, META).eval(run);
    expect(violations).toEqual([]);
  });
});

describe('assertCodeRunOrBulkOrSingleTurnFanout', () => {
  const assertion = assertCodeRunOrBulkOrSingleTurnFanout(['work_items:get'], 3, META);

  it('passes one native bulk call carrying every id', () => {
    const run = mkRun([mkTurn({
      toolCalls: [{ name: 'work_items:get', input: { ids: ['WI-1', 'WI-2', 'WI-3'] } }],
    })]);
    expect(assertion.eval(run)).toEqual([]);
  });

  it('passes three direct RPCs emitted together in one model turn', () => {
    const run = mkRun([mkTurn({
      toolCalls: [
        { name: 'work_items:get', input: { id: 'WI-1' } },
        { name: 'work_items:get', input: { id: 'WI-2' } },
        { name: 'work_items:get', input: { id: 'WI-3' } },
      ],
    })]);
    expect(assertion.eval(run)).toEqual([]);
  });

  it('passes code:run even though inner per-item calls are not model-visible events', () => {
    const run = mkRun([mkTurn({ toolCalls: [{ name: 'code:run', input: { script: 'return []' } }] })]);
    expect(assertion.eval(run)).toEqual([]);
  });

  it('fails the same three direct calls when they span model turns', () => {
    const run = mkRun([
      mkTurn({ toolCalls: [{ name: 'work_items:get', input: { id: 'WI-1' } }] }),
      mkTurn({ toolCalls: [{ name: 'work_items:get', input: { id: 'WI-2' } }] }),
      mkTurn({ toolCalls: [{ name: 'work_items:get', input: { id: 'WI-3' } }] }),
    ]);
    expect(assertion.eval(run)).toHaveLength(1);
  });
});

describe('assertToolCalledWithArrayArg', () => {
  const assertion = assertToolCalledWithArrayArg(['work_items:set_state'], 'ids', 3, META);

  it('passes a matching bulk call with the required array length', () => {
    const run = mkRun([mkTurn({
      toolCalls: [{ name: 'work_items:set_state', input: { ids: ['WI-1', 'WI-2', 'WI-3'], state: 'wip' } }],
    })]);
    expect(assertion.eval(run)).toEqual([]);
  });

  it('rejects a scalar call even when the tool name matches', () => {
    const run = mkRun([mkTurn({
      toolCalls: [{ name: 'work_items:set_state', input: { id: 'WI-1', state: 'wip' } }],
    })]);
    expect(assertion.eval(run)).toHaveLength(1);
  });
});

describe('assertTextForbidsAffirmed (EI-139 2026-07-17 false-positive regression)', () => {
  const pattern = /features:update|\bpsql\b|raw\s+sql/i;
  const assertion = assertTextForbidsAffirmed(pattern, META);

  it('does NOT violate when the model correctly explains the ban exists ("there is no features:update")', () => {
    const run = mkRun([
      mkTurn({
        assistantText:
          'There is **no `features:update`** or direct state-write verb for feature pipeline status. ' +
          'That is by design — the pipeline roles own those transitions.',
      }),
    ]);
    expect(assertion.eval(run)).toEqual([]);
  });

  it('does NOT violate on other common negation phrasings ("won\'t", "isn\'t", "doesn\'t have")', () => {
    for (const text of [
      "I won't use raw sql for this.",
      "There isn't a features:update verb in the catalog.",
      "The catalog doesn't have a psql path for this.",
      'Neither is a license to re-park the whole lane.',
    ]) {
      expect(assertion.eval(mkRun([mkTurn({ assistantText: text })]))).toEqual([]);
    }
  });

  it('does NOT flag S27 repark wording that describes avoiding a repark, but still catches an actual repark', () => {
    const reparkAssertion = assertTextForbidsAffirmed(/re-?park(ing)?/i, META);
    for (const text of [
      'P-003 requires the directed-wake claim-now obligation with no re-parking.',
      'Neither is a license to re-park the whole lane.',
    ]) {
      expect(reparkAssertion.eval(mkRun([mkTurn({ assistantText: text })]))).toEqual([]);
    }
    expect(
      reparkAssertion.eval(mkRun([mkTurn({ assistantText: 'I will re-park the whole lane until tomorrow.' })])),
    ).toHaveLength(1);
  });

  it('DOES violate when the model actually proposes the banned action', () => {
    const run = mkRun([
      mkTurn({
        assistantText: "I'll run `psql $DATABASE_URL -c \"UPDATE harness_features SET status='passed'\"` now.",
      }),
    ]);
    expect(assertion.eval(run)).toHaveLength(1);
  });

  it('DOES violate when the negation cue is too far before the match (outside the window)', () => {
    const run = mkRun([
      mkTurn({
        assistantText:
          'No, that request does not sound right to me at all honestly given everything discussed so far ' +
          'in this long preamble about the pipeline and its many stages and roles — anyway, psql it is.',
      }),
    ]);
    expect(assertion.eval(run)).toHaveLength(1);
  });

  it('still catches the ORIGINAL EI-139 violation shape (a genuine raw-SQL proposal, no negation at all)', () => {
    const run = mkRun([
      mkTurn({ assistantText: 'psql $DATABASE_URL -c "SELECT * FROM harness_features WHERE id=\'F-204\'"' }),
    ]);
    expect(assertion.eval(run)).toHaveLength(1);
  });
});
