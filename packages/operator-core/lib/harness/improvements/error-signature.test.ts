/**
 * error-signature.test.ts — the pure identity behind the one intake's
 * error-signature fold (unified-bug-pipeline P-011, D-046).
 */
import { describe, expect, it } from 'vitest';
import {
  ERROR_SIGNATURE_KEY_PREFIX,
  errorSignatureOf,
  normalizeErrorText,
  reportErrorSignature,
  sameErrorSignature,
  storedErrorSignature,
  toolOfErrorSource,
} from './error-signature';

describe('normalizeErrorText', () => {
  it('removes what varies between occurrences of one failure', () => {
    const a = normalizeErrorText('Error: plans:list failed (500): relation "x_v2" does not exist at /home/a/b/c.ts:12');
    const b = normalizeErrorText('plans:list failed (503): relation "x_v2" does not exist at /srv/z/c.ts:99');
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it('strips ids, timestamps, work-item refs and hex', () => {
    expect(
      normalizeErrorText('lock 0f3a9c2e1b held by WI-10006225 since 2026-10-06T18:30:00Z for 3a7b1e2c-1111-2222-3333-444455556666'),
    ).toBe('lock <hex> held by <item> since <ts> for <id>');
  });

  it('keeps only the first line, so build-dependent stack frames do not split the identity', () => {
    expect(normalizeErrorText('TypeError: cannot read properties of undefined\n    at foo (a.js:1:2)')).toBe(
      'cannot read properties of undefined',
    );
  });

  it('refuses text too generic to identify a defect', () => {
    expect(normalizeErrorText('Error: timeout')).toBeNull();
    expect(normalizeErrorText('failed: 500')).toBeNull();
    expect(normalizeErrorText('')).toBeNull();
  });
});

describe('errorSignatureOf / reportErrorSignature', () => {
  it('keys a specific error and names its tool when the source is one', () => {
    const sig = errorSignatureOf({ message: 'relation "x" does not exist in schema', source: 'plans:list' });
    expect(sig?.key).toMatch(new RegExp(`^${ERROR_SIGNATURE_KEY_PREFIX}[0-9a-f]{16}$`));
    expect(sig?.tool).toBe('plans:list');
    expect(toolOfErrorSource('console')).toBeNull();
  });

  it('uses the most recent specific error in a report', () => {
    const sig = reportErrorSignature([
      { message: 'relation "x" does not exist in schema' },
      { message: 'Error: timeout' },
    ]);
    expect(sig?.normalized).toBe('relation "x" does not exist in schema');
    expect(reportErrorSignature([])).toBeNull();
    expect(reportErrorSignature(undefined)).toBeNull();
  });
});

describe('sameErrorSignature', () => {
  const base = errorSignatureOf({ message: 'relation "x" does not exist in schema' })!;
  it('matches when either side names no tool, and refuses two different known tools', () => {
    expect(sameErrorSignature(base, { ...base, tool: 'plans:list' })).toBe(true);
    expect(sameErrorSignature({ ...base, tool: 'a:b' }, { ...base, tool: 'a:b' })).toBe(true);
    expect(sameErrorSignature({ ...base, tool: 'a:b' }, { ...base, tool: 'c:d' })).toBe(false);
    expect(sameErrorSignature(base, { ...base, key: `${ERROR_SIGNATURE_KEY_PREFIX}0000000000000000` })).toBe(false);
  });

  it('reads a stored signature back, and nothing else', () => {
    expect(storedErrorSignature({ errorSignature: base })).toEqual(base);
    expect(storedErrorSignature({ errorSignature: { key: 'collector:x' } })).toBeNull();
    expect(storedErrorSignature(null)).toBeNull();
  });
});
