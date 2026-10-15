import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

// Root maintenance scripts use node:test. Run their existing contracts here so
// the operator-core lane selected by scripts/ changes also guards native review.
describe('native tutorial review launcher — EI-25577038816918218', () => {
  it('runs the maintained source custody, speech readiness and path re-entry contracts', () => {
    const output = execFileSync(process.execPath, [
      '--test', '--test-reporter=tap', 'scripts/review-cloud-tutorial-native.test.mjs',
    ], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(output).toContain('desktop re-entry keeps caller-relative manifests and roots');
    expect(output).toMatch(/# tests [1-9]\d*/);
    expect(output).toMatch(/# fail 0\b/);
    expect(output).toMatch(/# cancelled 0\b/);
    expect(output).toMatch(/# skipped 0\b/);
  }, 20_000);
});
