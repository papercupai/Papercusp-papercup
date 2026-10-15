import { defineVitestConfig, BASELINE_SCHEMA_GLOBAL_SETUP_PATH } from '@papercusp/test-config/vitest-config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { prepareRuntimeReader } from './vitest.e2e.config.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Reuse the live profile's selected runtime for integration evidence as well.
// Configuration preparation stays outside the reporter's bounded observation.
const profileRuntimeReader = await prepareRuntimeReader();
// Preload the existing host resolver before the reporter's bounded witness
// read. Ordinary isolated integration suites do not open the live-host graph.
const liveRuntime = process.env.PAPERCUSP_WOE_SERVED_AUDIT === '1'
  ? await tsImport('./lib/runtime-vintage.ts', import.meta.url) : null;
const liveRuntimeDb = liveRuntime ? await tsImport('@papercusp/db-org', import.meta.url) : null;
const posthogRuntimeUnit = process.env.PAPERCUSP_TEST_POSTHOG_LIVE === 'true'
  ? process.env.PAPERCUSP_TEST_POSTHOG_RUNTIME_UNIT : null;
const remoteRuntime = posthogRuntimeUnit ? await tsImport('./lib/remote-runtime-identity.ts', import.meta.url) : null;

// The SP1 C4 carve moved the plans/cross_harness integration tests here; they
// inject('baselineSchemaDsn') via _pg-tool-fixture, so this package needs the
// shared baseline-schema globalSetup (was only wired in apps/operator before).
// The admin test-runs reporter is auto-wired by defineVitestConfig.
// Coverage-census attribution (P-004) — see the note in vitest.config.ts. The INTEGRATION
// layer is where this actually produces rows: it is the layer with a reachable Postgres, so a
// flush lands instead of disabling the sink.
export default defineVitestConfig({
  layer: 'integration',
  exclude: ['lib/blueprint/launch-blueprint-account-route.e2e.test.ts'],
  ...(profileRuntimeReader || liveRuntime || remoteRuntime ? {
    readRuntimeEnvironment: async () => {
      if (profileRuntimeReader) return profileRuntimeReader();
      if (remoteRuntime && posthogRuntimeUnit) {
        const units = [posthogRuntimeUnit];
        const fingerprint = await remoteRuntime.measureRuntimeEnvironment([], units);
        return fingerprint ? { schemaVersion: 1 as const, units, fingerprint, observedAt: new Date().toISOString() } : null;
      }
      const units = ['hono-host:3170'];
      const { sql } = liveRuntimeDb!.createDedicatedOrgPg('woe-integration-runtime', { max: 1 });
      try {
        const fingerprint = liveRuntime.measureRuntimeVintageEnvironment(
          await liveRuntime.listRuntimeVintage('papercusp-workspace', sql), units,
        );
        return fingerprint ? { schemaVersion: 1 as const, units, fingerprint, observedAt: new Date().toISOString() } : null;
      } finally {
        await sql.end({ timeout: 1 });
      }
    },
  } : {}),
  globalSetup: [BASELINE_SCHEMA_GLOBAL_SETUP_PATH, resolve(__dirname, 'test/_org-template.globalSetup.ts')],
  setupFiles: [
    resolve(__dirname, 'lib/coverage-census/attribution/setup-vitest.ts'),
    // Integration routes also start tracked lazy imports (e.g. session end).
    // Join them before teardown, using the same registry as the unit lane.
    resolve(__dirname, 'lib/detached-imports/setup-vitest.ts'),
  ],
});
