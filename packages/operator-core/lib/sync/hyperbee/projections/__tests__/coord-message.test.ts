/**
 * Unit tests for the coord_event_log (message rail) projection (Track A,
 * distributed-coordination-shared-harness-2026-06-04). Pure — no PG.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCoordMessageProjection,
  isCoordMessageRow,
  _testing,
  type CoordMessageRow,
} from '../coord-message';

const valid: CoordMessageRow = {
  harness_slug: 'papercup',
  msg_id: 'mq00-0000-abc',
  surface: 'messages',
  writer_key: 'su-1',
  body: { ts: '2026-06-04T00:00:00Z', msg_id: 'mq00-0000-abc', from: 'su-1', to: ['su-2'], kind: 'message', summary: 'hi' },
  ts: 1_700_000_000_000,
};

describe('coord-message supersede federation (EI-21467654382027859)', () => {
  it('accepts a message marked superseded by a correction', () => {
    // Without these fields on the wire, a message CORRECTED on one machine reads
    // as current on every other — a peer acts on the original with no sign a
    // correction exists, which is what the correction was sent to prevent.
    const corrected: CoordMessageRow = {
      ...valid,
      superseded_by_msg_id: 'mq00-0000-correction',
      superseded_at: 1_700_000_500_000,
    };
    expect(isCoordMessageRow(corrected)).toBe(true);
  });

  it('accepts a row from a peer that omits the superseded_* keys entirely', () => {
    // decodeValue DISCARDS a row the validator rejects, so a required field here
    // would drop every message from a peer running older code — strictly worse
    // than the missing marker. Absent means "not superseded".
    expect('superseded_by_msg_id' in valid).toBe(false);
    expect(isCoordMessageRow(valid)).toBe(true);
  });

  it('still rejects superseded_* of the wrong TYPE (loosened for absent, not for garbage)', () => {
    expect(isCoordMessageRow({ ...valid, superseded_by_msg_id: 7 })).toBe(false);
    expect(isCoordMessageRow({ ...valid, superseded_at: 'yesterday' })).toBe(false);
  });
});

describe('coord-message projection', () => {
  it('exposes the registered tableTag', () => {
    const p = buildCoordMessageProjection({ workspaceId: 'w', harnessSlug: 'papercup' });
    expect(p.tableTag).toBe('coord-messages');
  });

  it('composeKey is the msg_id', () => {
    expect(_testing.composeKey(valid)).toBe('mq00-0000-abc');
  });

  it('decodeValue accepts a well-formed harness-scoped message', () => {
    expect(_testing.decodeValue(valid)).toEqual(valid);
    expect(isCoordMessageRow(valid)).toBe(true);
  });

  it('accepts handoff + escalation surfaces; rejects plan-events and unknown surfaces', () => {
    expect(isCoordMessageRow({ ...valid, surface: 'handoffs' })).toBe(true);
    expect(isCoordMessageRow({ ...valid, surface: 'escalations' })).toBe(true);
    expect(isCoordMessageRow({ ...valid, surface: 'plan-events' })).toBe(false);
    expect(isCoordMessageRow({ ...valid, surface: 'nope' })).toBe(false);
  });

  it('rejects a fan-out delivery copy (body.notify_kind set) — defensive double of the trigger filter', () => {
    expect(isCoordMessageRow({ ...valid, body: { ...valid.body, notify_kind: 'topic' } })).toBe(false);
  });

  it('accepts a null writer_key (event surfaces write NULL)', () => {
    expect(isCoordMessageRow({ ...valid, surface: 'handoffs', writer_key: null })).toBe(true);
  });

  it('rejects missing / wrong-typed required fields', () => {
    expect(isCoordMessageRow({ ...valid, msg_id: '' })).toBe(false);
    expect(isCoordMessageRow({ ...valid, harness_slug: '' })).toBe(false);
    expect(isCoordMessageRow({ ...valid, body: null })).toBe(false);
    expect(isCoordMessageRow({ ...valid, body: ['not', 'an', 'object'] })).toBe(false);
    expect(isCoordMessageRow({ ...valid, ts: 'soon' })).toBe(false);
    expect(isCoordMessageRow({ ...valid, writer_key: 5 })).toBe(false);
    expect(isCoordMessageRow(null)).toBe(false);
    expect(isCoordMessageRow({})).toBe(false);
  });

  it('the federated surface set is exactly messages/handoffs/escalations', () => {
    expect([..._testing.FEDERATED_SURFACES].sort()).toEqual(['escalations', 'handoffs', 'messages']);
  });
});

// WI-3914: `isCoordMessageRow` validates the WIRE-LEVEL msg_id/ts (which stamp
// the row's own columns) but never validated that the nested `body` itself
// carries those keys — the write-side twin of WI-3912's read-side crash fix
// (coord:feed's compareByTsThenId throwing on a body missing ts/msg_id).
describe('normalizeBodyTsMsgId (WI-3914)', () => {
  it('fills body.ts/body.msg_id from the wire-level fields when body has neither', () => {
    const row: CoordMessageRow = { ...valid, body: { summary: 'no ts or msg_id in body' } };
    const body = _testing.normalizeBodyTsMsgId(row);
    expect(body.ts).toBe(new Date(row.ts).toISOString());
    expect(body.msg_id).toBe(row.msg_id);
    expect(body.summary).toBe('no ts or msg_id in body'); // rest of body untouched
  });

  it('fills a missing key when body carries only one', () => {
    const tsOnly = _testing.normalizeBodyTsMsgId({ ...valid, body: { ts: '2020-01-01T00:00:00.000Z' } });
    expect(tsOnly.ts).toBe('2020-01-01T00:00:00.000Z'); // kept, not overridden
    expect(tsOnly.msg_id).toBe(valid.msg_id); // filled from wire

    const msgIdOnly = _testing.normalizeBodyTsMsgId({ ...valid, body: { msg_id: valid.msg_id } });
    expect(msgIdOnly.ts).toBe(new Date(valid.ts).toISOString());
    expect(msgIdOnly.msg_id).toBe(valid.msg_id);
  });

  it('canonicalizes a conflicting body msg_id to the wire-level message id', () => {
    const body = _testing.normalizeBodyTsMsgId({
      ...valid,
      body: { ...valid.body, ts: '2020-01-01T00:00:00.000Z', msg_id: 'peer-own-id' },
    });

    expect(body.msg_id).toBe(valid.msg_id);
    expect(body.ts).toBe('2020-01-01T00:00:00.000Z');
  });

  it('never overrides a body that already carries both — returns the SAME object reference', () => {
    const body = _testing.normalizeBodyTsMsgId(valid);
    expect(body).toBe(valid.body); // identity, not just equality: no unnecessary copy
  });

  it('treats an empty-string ts/msg_id as missing (not merely absent)', () => {
    const body = _testing.normalizeBodyTsMsgId({ ...valid, body: { ts: '', msg_id: '' } });
    expect(body.ts).toBe(new Date(valid.ts).toISOString());
    expect(body.msg_id).toBe(valid.msg_id);
  });
});
