/** Correlate one action to its real persisted result, never a global fixture marker. */
import assert from 'node:assert/strict';
import type { CoordEnvelope } from '@papercusp/coordination/core';

/** Automatic read retries are repeated receipts, not additional UI controls. */
export function verifyPrivateInsightsDenialCoverage(denials: readonly {
  control: string; status: number; body: string;
}[]) {
  const controls = ['cold-overview', 'token-refresh', 'warm-overview'];
  for (const denial of denials) {
    assert.ok(controls.includes(denial.control), 'denial must identify its intended UI control');
    assert.equal(denial.status, 403);
    assert.equal(JSON.parse(denial.body).error?.code, 'host_not_allowed');
  }
  for (const control of controls) assert.ok(denials.some(denial => denial.control === control),
    `missing actual Host denial for ${control}`);
  return { hostDenials: denials.length, denialControls: controls };
}

/** Both maintained Codex routes identify the same seeded native transcript. */
export function verifyPrivateHistoryStreams(
  streams: readonly { url: string; status: number }[],
  expected: {
    selected: { ownerId: string; sessionId: number; rolloutId: string };
    neighbor: { ownerId: string; sessionId: number; rolloutId: string };
  },
) {
  const queries = streams.map(stream => ({ ...stream, query: new URL(stream.url).searchParams }));
  const selected = queries.filter(({ query, status }) => status === 200
    && query.get('historyOwner') === expected.selected.ownerId
    && (query.get('codexSessionKey') === String(expected.selected.sessionId)
      || (!query.has('codexSessionKey') && query.get('codexRolloutId') === expected.selected.rolloutId)));
  assert.ok(selected.length, 'real stream must correlate the selected native transcript and owner');
  assert.ok(!queries.some(({ query }) => query.get('historyOwner') === expected.neighbor.ownerId
    || query.get('codexSessionKey') === String(expected.neighbor.sessionId)
    || query.get('codexRolloutId') === expected.neighbor.rolloutId), 'no neighbor stream may be requested');
  return selected.map(({ url, status }) => ({ url, status }));
}

/** A stop receipt identifies one launch, not just an owner reused over time. */
export function verifyPrivateStopReceipt(
  receipt: { status: number; body: any },
  expected: { ownerId: string; managedSessionId: number; startedAt: string },
) {
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  assert.equal(receipt.body.ok, true);
  assert.equal(receipt.body.ownerId, expected.ownerId, 'selected-owner stop receipt correlation');
  assert.equal(receipt.body.managedSessionId, expected.managedSessionId, 'selected-session receipt correlation');
  assert.equal(receipt.body.sessionStartedAt, expected.startedAt, 'selected-launch stop receipt correlation');
  assert.equal(receipt.body.status, 'stop-requested', 'stop disposition must be explicit');
}

export async function verifyPrivateCoordReceipt(
  receipt: { status: number; body: any },
  expected: { ownerId: string; summary: string; wake: boolean },
  getStored: (id: string) => Promise<(Pick<CoordEnvelope, 'to' | 'summary'> & { wake?: unknown }) | null>,
) {
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  assert.equal(receipt.body.results?.length, 1);
  const result = receipt.body.results[0];
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.to, [expected.ownerId], 'selected-recipient receipt correlation');
  assert.equal(typeof result.msg_id, 'string');
  const stored = await getStored(result.msg_id);
  assert.ok(stored, 'HTTP receipt must identify a durable message');
  assert.deepEqual(stored.to, [expected.ownerId], 'persisted recipient correlation');
  assert.equal(stored.summary, expected.summary, 'persisted action payload correlation');
  if (expected.wake) {
    assert.equal(result.wake?.pickupConfirmed, false, 'send-time wake cannot attest pickup');
    assert.equal(stored.wake, true);
  } else assert.notEqual(stored.wake, true, 'message action must not become a wake');
  return result.msg_id as string;
}
