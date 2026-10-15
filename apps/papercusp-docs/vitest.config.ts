import { defineConfig } from 'vitest/config';
import { gateParticipationConfig, sharedHostWorkerCap } from '@papercusp/test-config/vitest-config';

// Hand-rolled like apps/papercusp-publish: gateParticipationConfig() wires the
// /admin/testing reporter and the gate's pass-proof recorder; sharedHostWorkerCap()
// keeps a direct `npx vitest run` from forking one worker per host core (WI-4300).
// Public-manual suites exercise unit-level content and source contracts.
export default defineConfig({
  test: {
    include: ['lib/**/*.test.ts'],
    ...sharedHostWorkerCap(),
    ...gateParticipationConfig(),
  },
});
