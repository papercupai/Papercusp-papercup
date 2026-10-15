import { describe, expect, it } from 'vitest';
import { CUE_AUTHORITY_FIELD } from '../agent-tools/coordination/cue-authority';
import { ALLHIVE_BROADCAST_FIELD } from '../agent-tools/coordination/scope-broadcast';
import { COORD_ROUTING_KEYS, SEALED_FIELD, mergeUnsealed, sealMarkerOf, splitForSeal } from './coord-seal';

const MSG_ID = 'mabc-0000-0123456789abcdef0123456789abcdef';

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    ts: '2026-10-01T16:00:00.000Z',
    msg_id: MSG_ID,
    from: 'su-restricted',
    to: ['su-peer'],
    kind: 'message',
    expects: 'answer',
    expectsReply: true,
    wakeOnReply: true,
    plan_slug: 'some-plan',
    summary: 'Alice says the merger closes Friday',
    body: 'Full text of the private email…',
    files: ['notes/alice.md'],
    sections: [{ text: 'Alice says…' }],
    report: { title: 'r', plans: [{ title: 'p' }] },
    [CUE_AUTHORITY_FIELD]: { scope: 'hive' },
    ...overrides,
  };
}

describe('splitForSeal', () => {
  it('keeps only routing keys on the stub and moves everything authored into the sealed content', () => {
    const split = splitForSeal(envelope(), 2)!;
    expect(split).not.toBeNull();
    for (const key of Object.keys(split.stub)) {
      expect(COORD_ROUTING_KEYS.has(key) || key === 'summary' || key === SEALED_FIELD).toBe(true);
    }
    expect(split.stub).toMatchObject({
      msg_id: MSG_ID,
      from: 'su-restricted',
      to: ['su-peer'],
      kind: 'message',
      expects: 'answer',
      wakeOnReply: true,
      [CUE_AUTHORITY_FIELD]: { scope: 'hive' },
    });
    expect(split.content).toEqual({
      summary: 'Alice says the merger closes Friday',
      body: 'Full text of the private email…',
      files: ['notes/alice.md'],
      sections: [{ text: 'Alice says…' }],
      report: { title: 'r', plans: [{ title: 'p' }] },
    });
  });

  it('replaces the summary with a stub that names the sender and how to open it, and carries none of the authored text', () => {
    const split = splitForSeal(envelope(), 2)!;
    expect(split.stub.summary).toContain('su-restricted');
    expect(split.stub.summary).toContain(`coord:read { msg_id: '${MSG_ID}', unseal: true }`);
    const serialized = JSON.stringify(split.stub);
    expect(serialized).not.toContain('merger');
    expect(serialized).not.toContain('private email');
    expect(serialized).not.toContain('alice.md');
    expect(sealMarkerOf(split.stub)).toEqual({ labels: 2, open: `coord:read { msg_id: '${MSG_ID}', unseal: true }` });
  });

  it('seals a key it has never heard of (allowlist, not denylist)', () => {
    const split = splitForSeal(envelope({ someFutureField: 'secret detail' }), 1)!;
    expect(split.content.someFutureField).toBe('secret detail');
    expect(split.stub).not.toHaveProperty('someFutureField');
  });

  it('returns null for an envelope with nothing authored, which is persisted unchanged', () => {
    const bare = { ts: 't', msg_id: MSG_ID, from: 'su-restricted', to: ['su-peer'], kind: 'ack', related_msg_id: 'm-1' };
    expect(splitForSeal(bare, 1)).toBeNull();
  });

  it('pins the routing allowlist to the coord field constants it names', () => {
    expect(COORD_ROUTING_KEYS.has(CUE_AUTHORITY_FIELD)).toBe(true);
    expect(COORD_ROUTING_KEYS.has(ALLHIVE_BROADCAST_FIELD)).toBe(true);
    for (const content of ['summary', 'body', 'files', 'sections', 'report', 'why']) {
      expect(COORD_ROUTING_KEYS.has(content)).toBe(false);
    }
  });
});

describe('mergeUnsealed', () => {
  it('restores the envelope the sender wrote and drops the seal marker', () => {
    const original = envelope();
    const split = splitForSeal(original, 1)!;
    const merged = mergeUnsealed(split.stub, split.content);
    expect(merged).toEqual(original);
    expect(sealMarkerOf(merged)).toBeNull();
  });

  it('never lets sealed content overwrite a routing key', () => {
    const split = splitForSeal(envelope(), 1)!;
    const merged = mergeUnsealed(split.stub, { ...split.content, from: 'su-forged', to: ['*'] });
    expect(merged.from).toBe('su-restricted');
    expect(merged.to).toEqual(['su-peer']);
  });
});

describe('sealMarkerOf', () => {
  it('reads only a well-formed marker', () => {
    expect(sealMarkerOf(null)).toBeNull();
    expect(sealMarkerOf({ sealed: true })).toBeNull();
    expect(sealMarkerOf({ sealed: { labels: '2', open: 'x' } })).toBeNull();
    expect(sealMarkerOf({ sealed: { labels: 2, open: 'x' } })).toEqual({ labels: 2, open: 'x' });
  });
});
