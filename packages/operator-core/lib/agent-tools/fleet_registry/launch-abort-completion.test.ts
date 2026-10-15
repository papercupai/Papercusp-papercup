import type { ToolResult } from '@papercusp/tooldef';
import { describe, expect, it } from 'vitest';

import { json } from './_shared';
import { fleetLaunchAbortCompletionReceipt } from './launch-abort-completion';

/**
 * WI-10005670 — `fleet:launch-on-plan` completion receipt. The launch persists a durable
 * transaction and opens members before it builds its response, so a handler that returns just
 * past the 60s dispatch budget has LAUNCHED; reporting a bare timeout invites a retry that
 * opens a second wave. Inputs are built with the tool's own `json()` response helper.
 */

const transaction = { transactionId: 'txn-123', state: 'verified', verifiedMemberIds: ['su-1'] };

describe('fleet:launch-on-plan abort-completion receipt (WI-10005670)', () => {
  it('reports a late completed launch by its durable transaction identity', () => {
    const result = json({ ok: true, fleet: 'drain-a', launchTransaction: transaction }) as ToolResult;
    expect(fleetLaunchAbortCompletionReceipt({}, result)).toEqual({
      status: 'recorded',
      effectRef: 'fleet-launch:drain-a:txn-123',
    });
  });

  it('also covers the bounded-response (completionPending) path', () => {
    const result = json({
      ok: true,
      fleet: 'drain-a',
      completionPending: true,
      completionHandle: { transactionId: 'txn-123', fleet: 'drain-a', status: 'pending' },
      launchTransaction: transaction,
    }) as ToolResult;
    expect(fleetLaunchAbortCompletionReceipt({}, result)).toMatchObject({
      status: 'recorded',
      effectRef: 'fleet-launch:drain-a:txn-123',
    });
  });

  it('fails closed without a transaction identity or a fleet', () => {
    expect(fleetLaunchAbortCompletionReceipt({}, json({ ok: true, fleet: 'drain-a' }) as ToolResult)).toMatchObject({
      status: 'recovery-incomplete',
      failures: ['missing-launch-transaction-id'],
    });
    expect(
      fleetLaunchAbortCompletionReceipt({}, json({ ok: true, launchTransaction: transaction }) as ToolResult),
    ).toMatchObject({ status: 'recovery-incomplete', failures: ['missing-fleet'] });
    expect(
      fleetLaunchAbortCompletionReceipt({}, { content: [{ type: 'text', text: 'boom' }] } as ToolResult),
    ).toMatchObject({ status: 'recovery-incomplete' });
  });
});
