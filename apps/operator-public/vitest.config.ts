import { defineConfig } from 'vitest/config';
import { gateParticipationConfig, sharedHostWorkerCap } from '@papercusp/test-config/vitest-config';
import { REGISTERED_VITEST_FILE_PROJECTS } from '@papercusp/test-config/execution-details';

const participation = gateParticipationConfig();
const fileProjects = REGISTERED_VITEST_FILE_PROJECTS.filter(project => project.root === 'apps/operator-public');

// Hand-rolled config for this package's per-file projects. gateParticipationConfig() wires
// the /admin/testing reporter, the per-file pass-proof recorder + input capture when the
// runner arms them, and the reuse skip list (WI-10003716). Keep the shared layer hook budgets
// below; reporter opt-out remains available through env.
export default defineConfig({
  test: {
    // WI-4300: the shared-host worker cap — without it a direct `npx vitest run` in
    // this workspace forks ~one worker per host core (128 on the shared dev box).
    ...sharedHostWorkerCap(),
    ...participation,
    // Match defineVitestConfig's unit budget instead of Vitest's 10s default.
    hookTimeout: 60_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          exclude: [...participation.exclude, ...fileProjects.flatMap(project =>
            project.files.map(file => `**/${file.slice(file.lastIndexOf('/') + 1)}`))],
          provide: { papercuspTestLayer: 'unit' },
        },
      },
      ...fileProjects.map(project => ({
        extends: true as const,
        test: {
          name: project.name,
          include: [...project.files],
          provide: { papercuspTestLayer: project.layer },
          // Match defineVitestConfig's integration budget. The shared PG teardown
          // allows a 20s DROP plus janitor work, which exceeds Vitest's 10s default.
          hookTimeout: project.layer === 'integration'
            ? Number(process.env.VITEST_INTEGRATION_HOOK_TIMEOUT_MS) || 90_000
            : 60_000,
        },
      })),
    ],
  },
});
