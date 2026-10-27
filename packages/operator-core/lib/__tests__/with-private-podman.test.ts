import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

// scripts/ is routed to operator-core by test:affected. Keep the maintained
// Node suite reachable from that workspace's CI, using its own test runner.
test('private Podman lifecycle suite cleans workloads after observer loss', () => {
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap',
    'scripts/with-private-podman.test.mjs'], {
    // The inner suite waits on REAL wrapper deadlines (~17s even on an idle host), so a
    // 20s budget left no headroom and killed it (ETIMEDOUT) whenever the host was busy.
    cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024,
  });
  const output = run.stdout ?? '';
  // A bare "Command failed" hides WHICH inner case failed; carry the TAP failures and the
  // stderr tail into the assertion so a red gate run is diagnosable from its own output.
  const lines = output.split('\n');
  const failures = lines.flatMap((line, i) => (/^\s*not ok \d+/.test(line)
    // Each TAP failure's YAML block names its error, code and first stack frame.
    ? [line, ...lines.slice(i + 1, i + 40).filter((l) => /^\s+(error|code|failureType|expected|actual):|^\s+\S+ \(.*:\d+:\d+\)$/.test(l)).slice(0, 6)]
    : /^# (pass|fail)/.test(line) ? [line] : [])).join('\n').slice(0, 6000);
  const detail = `status=${run.status} signal=${run.signal} error=${run.error?.message ?? 'none'}\n`
    + `${failures}\n--- stdout tail ---\n${output.slice(-2000)}\n--- stderr tail ---\n${(run.stderr ?? '').slice(-1500)}`;
  expect(run.status, detail).toBe(0);
  expect(output).toMatch(/^ok \d+ - wrapper deadline survives observer exit and cleans command descendants$/m);
  expect(output).toMatch(/# fail 0\b/);
  expect(output).toMatch(/# skipped 0\b/);
}, 130_000);
