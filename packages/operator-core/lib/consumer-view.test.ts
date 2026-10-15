import { describe, expect, it } from 'vitest';
import { buildConsumerView } from './consumer-view';

const READ_PATH = 'harness_shared.session_briefs.control_state->activation';

describe('buildConsumerView (EI-23770243810745552)', () => {
  it('reports agreement when the consumer read returns what the write intended', () => {
    const written = { status: 'desired', desired: { specificationRevision: 'a', stateRevision: 's1' } };
    const view = buildConsumerView({ readPath: READ_PATH, written, consumed: { ...written } });
    expect(view).toEqual({ readPath: READ_PATH, value: written, divergedFromWrite: false });
  });

  it('reports divergence when the consumer read returns something other than the write', () => {
    // The WI-10002021 shape: the writer updated one path, the consumer reads a decoy.
    const written = { status: 'desired', desired: { specificationRevision: 'new', stateRevision: 's2' } };
    const consumed = { status: 'applied', desired: { specificationRevision: 'old', stateRevision: 's1' } };
    const view = buildConsumerView({ readPath: READ_PATH, written, consumed });
    expect(view.divergedFromWrite).toBe(true);
    expect(view.value).toBe(consumed);
    expect(view.readPath).toBe(READ_PATH);
  });

  it('ignores object key order (jsonb structural equality) but not array order', () => {
    expect(
      buildConsumerView({ readPath: READ_PATH, written: { a: 1, b: 2 }, consumed: { b: 2, a: 1 } }).divergedFromWrite,
    ).toBe(false);
    expect(
      buildConsumerView({ readPath: READ_PATH, written: [1, 2], consumed: [2, 1] }).divergedFromWrite,
    ).toBe(true);
  });

  it('treats undefined and null as the same absent value, but absent vs present as divergence', () => {
    expect(buildConsumerView({ readPath: READ_PATH, written: undefined, consumed: null }).divergedFromWrite).toBe(false);
    expect(buildConsumerView({ readPath: READ_PATH, written: null, consumed: undefined }).divergedFromWrite).toBe(false);
    expect(buildConsumerView({ readPath: READ_PATH, written: { a: 1 }, consumed: null }).divergedFromWrite).toBe(true);
    expect(buildConsumerView({ readPath: READ_PATH, written: null, consumed: { a: 1 } }).divergedFromWrite).toBe(true);
  });

  it('cannot prove agreement for a value JSON cannot represent, so it reports divergence', () => {
    const view = buildConsumerView({ readPath: READ_PATH, written: { n: 1n }, consumed: { n: 1n } });
    expect(view.divergedFromWrite).toBe(true);
    const nonFinite = buildConsumerView({ readPath: READ_PATH, written: Number.NaN, consumed: Number.NaN });
    expect(nonFinite.divergedFromWrite).toBe(true);
  });

  it('CONTROL: a deliberately-wrong comparator (reference equality) disagrees with the real one', () => {
    // Keeps the suite falsifiable: structural equality must call these equal where
    // `===` does not, so a regression to identity comparison fails the tests above.
    const written = { a: [1, { b: 2 }] };
    const consumed = { a: [1, { b: 2 }] };
    expect(written === consumed).toBe(false);
    expect(buildConsumerView({ readPath: READ_PATH, written, consumed }).divergedFromWrite).toBe(false);
  });
});
