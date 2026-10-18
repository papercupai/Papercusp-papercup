import { describe, expect, it } from 'vitest';
import { classifyAgentWait } from './wait-classification';

describe('agent wait classification', () => {
  it('separates the exact owner inbox listener from a substantive dependency', () => {
    expect(classifyAgentWait('su-a', 'coord:inbox-wake:su-a')).toBe('listener');
    expect(classifyAgentWait('su-a', 'release:green:papercusp')).toBe('substantive');
    expect(classifyAgentWait('su-a', 'coord:inbox-wake:su-b')).toBe('substantive');
  });
  it('does not invent a wait from absent or malformed evidence', () => {
    for (const value of [null, undefined, '', ' ', 42, {}]) {
      expect(classifyAgentWait('su-a', value)).toBe('none');
    }
  });
});
