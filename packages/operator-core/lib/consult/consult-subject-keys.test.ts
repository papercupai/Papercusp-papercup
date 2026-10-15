/**
 * consultSubjectKeys extracts explicit work-item ids so the consult archive only
 * reuses an answer about the same subject. Modern ids are long: EI- tails are
 * ~17 digits and slotted WI- ids are 16 (migration 1442, scope-unique-identifiers
 * P-010). A capped digit run followed by \b matches nothing at all, so these
 * ids used to be dropped silently.
 */
import { describe, expect, it } from 'vitest';
import { consultSubjectKeys } from './get-feedback-core';

describe('consultSubjectKeys explicit ids', () => {
  it('extracts short legacy ids', () => {
    expect(consultSubjectKeys('Why did WI-2944 fail?')).toContain('id:WI-2944');
  });

  it('extracts a 17-digit EI- id and a 16-digit slotted WI- id', () => {
    const keys = consultSubjectKeys('Is EI-25376675938595014 the same bug as WI-6554700010008294?');
    expect(keys).toContain('id:EI-25376675938595014');
    expect(keys).toContain('id:WI-6554700010008294');
  });

  it('keeps two questions about different long ids apart', () => {
    expect(consultSubjectKeys('status of WI-6554700010008294')).not.toEqual(
      consultSubjectKeys('status of WI-6554700010008295'),
    );
  });
});

describe('consultSubjectKeys explicit revision pins', () => {
  const subject = 'acceptance-byoc-delivery-acceleration-2026-09-06';

  it('normalizes compact and separated revision and hash labels', () => {
    const hash = 'a'.repeat(64);
    const compact = consultSubjectKeys(`Vet ${subject} rev8/hash${hash}`);
    expect(compact).toContain('revision:8');
    expect(compact).toContain(`hash:${hash}`);
    expect(compact).toEqual(
      consultSubjectKeys(`Vet ${subject} revision: 8 criteriaHash: ${hash.toUpperCase()}`),
    );
  });

  it('keeps changed or omitted explicit pins apart for the same subject', () => {
    const current = consultSubjectKeys(`Vet ${subject} revision8 criteriaHash${'a'.repeat(64)}`);
    for (const question of [
      `Vet ${subject} revision7 criteriaHash${'a'.repeat(64)}`,
      `Vet ${subject} revision8 criteriaHash${'b'.repeat(64)}`,
      `Vet ${subject}`,
    ]) expect(current).not.toEqual(consultSubjectKeys(question));
  });
});
