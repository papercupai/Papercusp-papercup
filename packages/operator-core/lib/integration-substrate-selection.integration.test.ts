import { describe, expect, inject, it } from 'vitest';
import type {} from '../test/_integration-substrate.globalSetup';

// Exercises the real integration config/globalSetup selection. If the baseline
// database is selected alongside this canary, its baseline must still be ready.
describe('integration selection without a PostgreSQL dependency', () => {
  it('keeps integration evidence and matches the selected database substrate', () => {
    expect(inject('papercuspTestLayer')).toBe('integration');
    const substrate = inject('operatorIntegrationSubstrate');
    expect(['none', 'postgres']).toContain(substrate);
    if (substrate === 'none') expect(inject('baselineSchemaDsn')).toBeUndefined();
    else expect(inject('baselineSchemaDsn')).toEqual(expect.stringMatching(/^postgres(?:ql)?:\/\//));
  });
});
