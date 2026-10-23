import { defineVitestConfig } from '@papercusp/test-config/vitest-config';

// Cloud production and runtime compatibility probes live under scripts/ rather than an npm workspace. Keep their
// integration lane explicit so test-runs evidence records `testLayer: integration` instead of
// falling through the repository root unit config.
export default defineVitestConfig({
  layer: 'integration',
  include: ['scripts/cloud-prod/**/*.integration.test.ts', 'scripts/runtime-compatibility.integration.test.ts'],
});
