import { describe, expect, it } from 'vitest';
import { ALL_FLAG_KEYS, DARK_FLAGS, FLAG_DEFAULTS, FLAGS } from './types';

describe('Reports library default-on contract (reports-library-2026-09-15 P-004)', () => {
  it('registers the existing publisher/viewer behind an enabled shared flag', () => {
    expect(ALL_FLAG_KEYS).toContain(FLAGS.REPORTS_LIBRARY);
    expect(FLAG_DEFAULTS[FLAGS.REPORTS_LIBRARY]).toBe(true);
    expect(DARK_FLAGS.has(FLAGS.REPORTS_LIBRARY)).toBe(false);
  });
});
