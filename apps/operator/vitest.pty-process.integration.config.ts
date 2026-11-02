import { defineVitestConfig } from '@papercusp/test-config/vitest-config';
import { mergeConfig } from 'vitest/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// This process-only fixture has no database dependency. Keep the integration-layer
// guard and runtime classification, while omitting the baseline PostgreSQL global setup.
export default mergeConfig(defineVitestConfig({
  layer: 'integration',
  include: ['lib/psu-pty-host-assume-fence.integration.test.ts'],
  globalSetup: [],
  setupFiles: [resolve(__dirname, 'vitest-shims/psu-pty-temp-dir.ts')],
}), {
  resolve: {
    alias: [
      { find: 'server-only', replacement: resolve(__dirname, 'vitest-shims/server-only.ts') },
      { find: /^@\//, replacement: `${resolve(__dirname)}/` },
    ],
  },
});
