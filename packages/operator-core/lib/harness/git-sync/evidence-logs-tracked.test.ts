/**
 * Evidence logs under docs/evidence/ must never be gitignored (WI-10006796).
 *
 * The root .gitignore ignores `*.log`. git-sync commits the shared tree with
 * `add -A`, which skips ignored files, so an evidence log a plan or rubric cites
 * stayed on one disk and never reached git — with no error anywhere. Twelve such
 * files across four plans were found this way. One directory-wide negation
 * (`!docs/evidence/**\/*.log`) now re-includes them; this test fails if that
 * negation is removed or shadowed by a later rule.
 *
 * `git check-ignore --no-index` asks the ignore rules about a path WITHOUT
 * consulting the index, so the answer does not depend on whether a file with
 * that name happens to be tracked or present. The positive control proves the
 * oracle still reports ignored paths, so a broken git call cannot pass this
 * test vacuously.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../../..');

/** true = ignored, false = not ignored; throws on any other git outcome. */
function isIgnored(repoRelPath: string): boolean {
  const r = spawnSync('git', ['check-ignore', '--no-index', '-q', repoRelPath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  throw new Error(`git check-ignore failed (status ${r.status}): ${r.stderr}`);
}

describe('docs/evidence logs are tracked (WI-10006796)', () => {
  it('positive control: a .log outside docs/evidence is still ignored', () => {
    expect(isIgnored('apps/operator/some-build-output.log')).toBe(true);
  });

  it.each([
    'docs/evidence/a-new-plan-2099-01-01/steps.log',
    'docs/evidence/a-new-plan-2099-01-01/nested/dir/run.log',
    'docs/evidence/top-level-evidence.log',
    'docs/evidence/desktop-dev-startup-speed-2026-10-06/bundle-host-step-timing.log',
  ])('%s is not ignored', (path) => {
    expect(isIgnored(path)).toBe(false);
  });
});
