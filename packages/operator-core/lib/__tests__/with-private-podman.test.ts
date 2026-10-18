import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

// scripts/ is routed to operator-core by test:affected. Keep the maintained
// Node suite reachable from that workspace's CI, using its own test runner.
test('private Podman lifecycle suite cleans workloads after observer loss', () => {
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap',
    'scripts/with-private-podman.test.mjs'], {
    cwd: root, encoding: 'utf8', timeout: 20_000, maxBuffer: 128 * 1024,
  });
  expect(output).toMatch(/^ok \d+ - wrapper deadline survives observer exit and cleans command descendants$/m);
  expect(output).toMatch(/# fail 0\b/);
  expect(output).toMatch(/# skipped 0\b/);
}, 25_000);
