import type { ToolResult } from '@papercusp/tooldef';
import { describe, expect, it } from 'vitest';

import { bulkContent, runBulk } from '../_bulk';
import workItemsCreate from './create';
import { workItemsCreateAbortCompletionReceipt } from './create-abort-completion';

/**
 * WI-10005718 — `work_items:create` completion receipt. The INSERT happens before the bulk
 * envelope is built, so a handler that returns just past the 60s dispatch budget HAS filed the
 * row; the caller used to get a bare `timeout`, losing the landed id and any downgrade notice
 * (e.g. `fleetScopeDowngrade`, filed UNASSIGNED by design — WI-10005040) and retrying into a
 * duplicate. Inputs here are built with the tool's own `runBulk` + `bulkContent` so the receipt
 * is exercised against the REAL envelope shape, not a hand-rolled approximation.
 */

/** What dispatch hands the resolver: the tool's `{ data }` return, serialized as one text block. */
function asToolResult(envelope: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(bulkContent(envelope)) }] } as ToolResult;
}

type Spec = { title: string; behavior: 'landed' | 'downgraded' | 'refused' | 'threw' };

async function realEnvelope(specs: Spec[]) {
  const env = await runBulk(specs, async (spec) => {
    if (spec.behavior === 'threw') throw new Error('pool exhausted');
    if (spec.behavior === 'refused') return { ok: false as const, error: 'duplicate of WI-1' };
    const id = `WI-${spec.title}`;
    return {
      ok: true as const,
      id,
      title: spec.title,
      workItem: { id, assignee: spec.behavior === 'downgraded' ? null : 'su-me' },
      ...(spec.behavior === 'downgraded'
        ? { fleetScopeDowngrade: { code: 'fleet_scope_violation' } }
        : {}),
    };
  });
  const sole = env.results.length === 1 ? (env.results[0] as { ok?: boolean; id?: string }) : undefined;
  return sole?.ok === true && sole.id ? { ...env, id: sole.id } : env;
}

describe('work_items:create abort-completion receipt (WI-10005718)', () => {
  it('reports a late single create by the landed work-item id (assigned)', async () => {
    const result = asToolResult(await realEnvelope([{ title: '1001', behavior: 'landed' }]));
    expect(workItemsCreateAbortCompletionReceipt({}, result)).toEqual({
      status: 'recorded',
      effectRef: 'work-item:WI-1001',
    });
  });

  it('records a landed-but-downgraded (filed UNASSIGNED) create — the WI-10005040 shape', async () => {
    const result = asToolResult(await realEnvelope([{ title: '1002', behavior: 'downgraded' }]));
    expect(workItemsCreateAbortCompletionReceipt({}, result)).toEqual({
      status: 'recorded',
      effectRef: 'work-item:WI-1002',
    });
  });

  it('records a partial batch by every landed id and ignores refused/thrown rows', async () => {
    const result = asToolResult(
      await realEnvelope([
        { title: '1003', behavior: 'landed' },
        { title: 'x', behavior: 'refused' },
        { title: 'y', behavior: 'threw' },
        { title: '1004', behavior: 'downgraded' },
      ]),
    );
    expect(workItemsCreateAbortCompletionReceipt({}, result)).toEqual({
      status: 'recorded',
      effectRef: 'work-item:WI-1003,WI-1004',
    });
  });

  it('fails closed (never "not-recorded") when no row landed — a thrown row looks like a refusal', async () => {
    for (const behavior of ['refused', 'threw'] as const) {
      const result = asToolResult(await realEnvelope([{ title: 'z', behavior }]));
      expect(workItemsCreateAbortCompletionReceipt({}, result)).toMatchObject({
        status: 'recovery-incomplete',
        failures: ['no-landed-work-item'],
      });
    }
  });

  it('fails closed on an unparseable, empty, or id-less result', () => {
    expect(
      workItemsCreateAbortCompletionReceipt({}, { content: [{ type: 'text', text: 'boom' }] } as ToolResult),
    ).toMatchObject({ status: 'recovery-incomplete' });
    expect(workItemsCreateAbortCompletionReceipt({}, { content: [] } as unknown as ToolResult)).toMatchObject({
      status: 'recovery-incomplete',
    });
    expect(
      workItemsCreateAbortCompletionReceipt({}, asToolResult({ ok: true, results: [{ ok: true }], counts: {} })),
    ).toMatchObject({ status: 'recovery-incomplete', failures: ['no-landed-work-item'] });
  });

  it('is declared on the tool itself (the receipt is what keeps dispatch from reporting a bare timeout)', () => {
    expect(workItemsCreate.abortCompletionReceipt).toBe(workItemsCreateAbortCompletionReceipt);
  });
});
