import { configDefaults } from 'vitest/config';
import { defineVitestConfig } from '@papercusp/test-config/vitest-config';

// The shared config couples the coverage provider with execution source receipts;
// gateParticipationConfig alone records test results but cannot publish per-test coverage.
export default defineVitestConfig({
  layer: 'unit',
  // Keep collecting both __tests__/ and src/ tests, as the prior Vitest default did.
  include: [...configDefaults.include],
  allowConsoleNoise: true,
});
