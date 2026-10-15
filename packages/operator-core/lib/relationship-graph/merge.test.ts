/**
 * Clustering and per-field merge of the platform relationship graph (crm-agent-sales-
 * onboarding-apps-2026-10-06 P-002, D-011 point 4).
 */
import { describe, expect, it } from 'vitest';
import { personIdentityKeys } from './identity-keys';
import { clusterByKeys, listProvenanceKey, mergeEntity, PARTICIPANT_DERIVATION, PERSON_FIELDS, type SourceEntityRecord } from './merge';

function record(id: string, observedAt: string, payload: Record<string, unknown>, source = 'src-a'): SourceEntityRecord {
  return { id, harness: 'papercusp', dataSourceId: source, provider: `provider-${source}`, observedAt, createdTs: 1, payload };
}

describe('clusterByKeys', () => {
  it('groups records transitively through any shared key', () => {
    const a = record('DSR-a', '2026-10-01T00:00:00.000Z', { emails: ['ada@acme.com'] });
    const b = record('DSR-b', '2026-10-01T00:00:00.000Z', { emails: ['ada@acme.com'], phones: ['+15551234567'] });
    const c = record('DSR-c', '2026-10-01T00:00:00.000Z', { phones: ['+1 555 123 4567'] });
    const d = record('DSR-d', '2026-10-01T00:00:00.000Z', { emails: ['bob@beta.io'] });
    const e = record('DSR-e', '2026-10-01T00:00:00.000Z', { displayName: 'no keys' });
    const clusters = clusterByKeys([d, c, e, b, a], (r) => personIdentityKeys(r.payload));
    expect(clusters.map((g) => g.map((r) => r.id))).toEqual([['DSR-a', 'DSR-b', 'DSR-c'], ['DSR-d'], ['DSR-e']]);
  });

  it('is independent of input order', () => {
    const rs = ['x', 'y', 'z', 'w'].map((s, i) => record(`DSR-${s}`, '2026-10-01T00:00:00.000Z', { emails: [i < 2 ? 'one@a.io' : 'two@b.io'] }));
    const forward = clusterByKeys(rs, (r) => personIdentityKeys(r.payload));
    const backward = clusterByKeys([...rs].reverse(), (r) => personIdentityKeys(r.payload));
    expect(backward).toEqual(forward);
  });
});

describe('mergeEntity', () => {
  const older = record('DSR-old', '2026-09-01T00:00:00.000Z', { displayName: 'Ada L.', title: 'CTO', emails: ['ada@acme.com'] }, 'gmail');
  const newer = record('DSR-new', '2026-10-01T00:00:00.000Z', { displayName: 'Ada Lovelace', emails: ['ADA@acme.com', 'ada@home.example'], phones: ['+1 555 123 4567'] }, 'phone');

  it('takes the most recently observed scalar and records where it came from', () => {
    const merged = mergeEntity(PERSON_FIELDS, [older, newer]);
    expect(merged.fields.displayName).toBe('Ada Lovelace');
    expect(merged.provenance.displayName).toEqual({
      source: { kind: 'record', recordId: 'DSR-new', dataSourceId: 'phone', provider: 'provider-phone' },
      observedAt: '2026-10-01T00:00:00.000Z',
      acceptedBy: null,
    });
    // A field only the older record has still survives, attributed to it.
    expect(merged.fields.title).toBe('CTO');
    expect(merged.provenance.title?.source).toMatchObject({ recordId: 'DSR-old' });
  });

  it('unions list values with per-value provenance from their latest observation', () => {
    const merged = mergeEntity(PERSON_FIELDS, [older, newer]);
    expect(merged.fields.emails).toEqual(['ada@acme.com', 'ada@home.example']);
    expect(merged.fields.phones).toEqual(['+15551234567']);
    expect(merged.provenance[listProvenanceKey('emails', 'ada@acme.com')]?.source).toMatchObject({ recordId: 'DSR-new' });
    expect(merged.provenance[listProvenanceKey('phones', '+15551234567')]?.observedAt).toBe('2026-10-01T00:00:00.000Z');
  });

  it('an accepted value outranks every observed value, with acceptedBy', () => {
    const merged = mergeEntity(PERSON_FIELDS, [older, newer], {
      displayName: { value: 'Countess Ada', acceptedBy: 'user:avi', acceptedAt: '2026-10-02T00:00:00.000Z' },
    });
    expect(merged.fields.displayName).toBe('Countess Ada');
    expect(merged.provenance.displayName).toEqual({ source: { kind: 'accepted' }, observedAt: '2026-10-02T00:00:00.000Z', acceptedBy: 'user:avi' });
  });

  it('breaks an observedAt tie on the lower record id', () => {
    const a = record('DSR-a', '2026-10-01T00:00:00.000Z', { displayName: 'From A' });
    const b = record('DSR-b', '2026-10-01T00:00:00.000Z', { displayName: 'From B' });
    expect(mergeEntity(PERSON_FIELDS, [b, a]).fields.displayName).toBe('From A');
  });

  it('a name a source states outranks a newer one read off an interaction header (D-013)', () => {
    const contact = record('DSR-contact', '2026-09-01T00:00:00.000Z', { displayName: 'Ada Lovelace', emails: ['ada@acme.com'] }, 'crm');
    const header = record('DSR-header', '2026-10-05T00:00:00.000Z', { displayName: 'ada', emails: ['ada@acme.com'], derivedFrom: PARTICIPANT_DERIVATION }, 'gmail');
    const merged = mergeEntity(PERSON_FIELDS, [header, contact]);
    expect(merged.fields.displayName).toBe('Ada Lovelace');
    expect(merged.provenance.displayName?.source).toMatchObject({ recordId: 'DSR-contact' });
    // With no direct record, the participant-derived name is used, so a person minted from mail has a name.
    expect(mergeEntity(PERSON_FIELDS, [header]).fields.displayName).toBe('ada');
  });
});
