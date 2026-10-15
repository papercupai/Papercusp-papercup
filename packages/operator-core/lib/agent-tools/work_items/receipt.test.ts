/**
 * oversized-tool-results-reduction-2026-10-12 P-002: write receipts must not starve lifecycle rules.
 *
 * The dispatcher hands `postInvoke` the same settled result the caller receives, so a reaction rule
 * reading `result.data.workItem.<field>` reads it off the RECEIPT (see receipt.ts). These tests run
 * the REAL registered rules (`matchReactions`) against an event carrying the full row and against
 * the same event carrying the receipt, and require identical matches + rendered args. Each case
 * also asserts that a named rule actually fires, so an empty registry cannot pass as "parity".
 */
import { describe, expect, it } from 'vitest';
import { matchReactions } from '../../events/registry';
import type { ToolInvocationEvent } from '../../events/types';
// Rules register by import side effect.
import '../../events/rules';
import '../../plan-items/reflect-rules';
import '../../decision-ledger/bet-signal-rule';
import '../../rationale/rules';
import { COMPLETE_RECEIPT, CREATE_RECEIPT, toWorkItemReceipt } from './receipt';

const PLAN_STAMP = { plan_slug: 'demo-plan', item_id: 'P-007', harness_slug: 'papercusp' };

/** A closed row shaped like the measured 2026-10-12 complete result (heavy fields included). */
function closedRow(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'WI-77',
    kind: 'change',
    family: 'issue',
    harness: 'papercusp',
    title: 'Close me',
    summary: 'S'.repeat(2400),
    state: 'done',
    assignee: 'su-x',
    severity: 'minor',
    payload: { ...payload, freshnessEnvelope: { observedAt: 'x' }, _claimSubjectBaseline: 'B'.repeat(700) },
    externalBlockers: [{ kind: 'gate', note: 'N'.repeat(1200) }],
    terminalOwner: 'su-x',
    terminalCompletionRef: 'completion:WI-77:1',
    terminalCompletionEvidence: { summary: 'E'.repeat(4000) },
    completionAuthority: 'committed',
    rank: null,
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T01:00:00.000Z',
    closedAt: '2026-10-12T01:00:00.000Z',
  };
}

function event(tool: string, args: Record<string, unknown>, data: Record<string, unknown>): ToolInvocationEvent {
  return { tool, args, result: { ok: true, data }, ctx: { uiClientId: 'sess-T' } as never };
}

/** What a rule does with an event: which rules match, what they fire, with which args. */
function reactions(e: ToolInvocationEvent): Array<{ ruleId: string; fire: string; args: unknown }> {
  return matchReactions(e)
    .map((m) => ({ ruleId: m.ruleId, fire: m.fire, args: m.args }))
    .sort((a, b) => a.ruleId.localeCompare(b.ruleId));
}

function expectParity(tool: string, args: Record<string, unknown>, data: Record<string, unknown>, receipt: Record<string, unknown>) {
  const full = reactions(event(tool, args, data));
  const trimmed = reactions(event(tool, args, { ...data, workItem: receipt }));
  expect(trimmed).toEqual(full);
  return full.map((r) => r.ruleId);
}

describe('COMPLETE_RECEIPT', () => {
  it('fires the same lifecycle reactions as the full row for a plan-item-stamped close', () => {
    const row = closedRow({ plan_item: PLAN_STAMP });
    const fired = expectParity(
      'work_items:complete',
      { id: 'WI-77' },
      { ok: true, id: 'WI-77', workItem: row, completion: { summary: 'done' } },
      toWorkItemReceipt(row, COMPLETE_RECEIPT),
    );
    expect(fired.some((id) => id.startsWith('plan-item-reflect'))).toBe(true);
  });

  it('fires the same lifecycle reactions as the full row for a bet-analysis close', () => {
    const row = closedRow({ domainKind: 'bet-analysis' });
    const fired = expectParity(
      'work_items:complete',
      { id: 'WI-77' },
      {
        ok: true,
        id: 'WI-77',
        workItem: row,
        completion: { summary: 'done' },
        outputPayload: { market: 'm', edge: 0.1, recommendation: 'bet', confidence: 0.7 },
      },
      toWorkItemReceipt(row, COMPLETE_RECEIPT),
    );
    expect(fired).toContain('oddsmith:bet-signal-disposition');
  });

  it('keeps the close fields and the rule-read payload keys, and drops the echoed bulk', () => {
    const receipt = toWorkItemReceipt(closedRow({ plan_item: PLAN_STAMP, out: { big: 'O'.repeat(500) } }), COMPLETE_RECEIPT);
    expect(receipt).toEqual({
      id: 'WI-77',
      state: 'done',
      assignee: 'su-x',
      kind: 'change',
      family: 'issue',
      harness: 'papercusp',
      title: 'Close me',
      severity: 'minor',
      terminalOwner: 'su-x',
      terminalCompletionRef: 'completion:WI-77:1',
      completionAuthority: 'committed',
      closedAt: '2026-10-12T01:00:00.000Z',
      payload: { plan_item: PLAN_STAMP },
    });
  });

  it('omits payload entirely when no rule-read key is present', () => {
    expect(toWorkItemReceipt(closedRow({}), COMPLETE_RECEIPT)).not.toHaveProperty('payload');
  });

  it('is a small fraction of the row it summarizes', () => {
    const row = closedRow({ plan_item: PLAN_STAMP });
    expect(JSON.stringify(toWorkItemReceipt(row, COMPLETE_RECEIPT)).length).toBeLessThan(JSON.stringify(row).length / 10);
  });
});

describe('CREATE_RECEIPT', () => {
  it('fires the same lifecycle reactions as the full row for a critical filing', () => {
    const row = {
      id: 'WI-88',
      kind: 'bug',
      family: 'issue',
      harness: 'papercusp',
      title: 'Critical thing',
      summary: 'S'.repeat(1500),
      state: 'open',
      assignee: null,
      severity: 'critical',
      payload: { _ei: { scope: 'harness:papercusp' } },
      createdAt: '2026-10-12T00:00:00.000Z',
    };
    const fired = expectParity(
      'work_items:create',
      { kind: 'bug', title: 'Critical thing', severity: 'critical' },
      { ok: true, id: 'WI-88', title: 'Critical thing', workItem: row },
      toWorkItemReceipt(row, CREATE_RECEIPT),
    );
    expect(fired.length).toBeGreaterThan(0);
  });
});
