// WI-10004928 / plan p2p-public-release-endgame-2026-09-01 D-129 (1): the checkpoint probe's
// exact file radius may coexist with repo-wide invariant guards (each runs as its own
// AFFECTED_GUARD leg), but a changed global runner input must still widen fully.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { stripCommentsAndStrings } from '../../../../scripts/lib/strip-comments-and-strings.mjs';
import {
  exactRadiusAdmission,
  isExactRadiusGlobalInput,
} from '../../../../scripts/lib/exact-radius-admission.mjs';

const ROOT = join(__dirname, '../../../..');

const admit = (changedPaths: string[], extra: Partial<Parameters<typeof exactRadiusAdmission>[0]> = {}) =>
  exactRadiusAdmission({ everyTaskNarrowable: true, affectedFileCount: 3, changedPaths, ...extra });

describe('exactRadiusAdmission (D-129 item 1)', () => {
  it('admits an ordinary source change (guards are not an input to the rule)', () => {
    expect(admit(['packages/operator-core/lib/release/targeted-reverdict.ts'])).toEqual({ admitted: true });
    expect(admit(['scripts/lib/related-tests.mjs', 'libs/flags/src/types.ts'])).toEqual({ admitted: true });
  });

  it.each([
    'package-lock.json',
    'package.json',
    'tsconfig.json',
    'vitest.config.ts',
    'vitest.workspace.ts',
    'patches/verdict-cli+0.1.1.patch',
    'libs/test-config/src/vitest-config.ts',
    'packages/operator-core/vitest.config.ts',
    'apps/operator/vite.config.ts',
    'packages/operator-core/package.json',
    'packages/operator-core/tsconfig.json',
    'apps/operator/tsconfig.app.json',
    'packages/operator-core/test/setup.ts',
    'apps/operator/vitest.setup.ts',
    'libs/x/test-setup.mts',
  ])('widens fully when a global runner input changes: %s', (path) => {
    expect(isExactRadiusGlobalInput(path)).toBe(true);
    // Mixed with an ordinary change, the global input still wins.
    expect(admit(['packages/operator-core/lib/foo.ts', path])).toEqual({
      admitted: false,
      reason: 'global-runner-input',
      path,
    });
  });

  it('does not treat ordinary code or test files as runner inputs', () => {
    for (const path of [
      'packages/operator-core/lib/setupWizard.tsx',
      'packages/operator-core/lib/release/green-checkpoint-setup-env.ts',
      'libs/test-config/src/vitest-config.test.ts',
      'apps/operator/lib/release/dependency-generation.test.ts',
    ]) {
      expect(isExactRadiusGlobalInput(path), path).toBe(false);
    }
  });

  it('refuses when a selected task is not runnable by the exact file runner', () => {
    expect(admit(['a/b.ts'], { everyTaskNarrowable: false })).toEqual({
      admitted: false,
      reason: 'non-file-runner-task',
    });
  });

  it('refuses an empty affected-file list (a graph gap is not proof)', () => {
    expect(admit(['a/b.ts'], { affectedFileCount: 0 })).toEqual({
      admitted: false,
      reason: 'no-affected-files',
    });
  });

  it('reasons are single tokens, so the RELATED_AFFECTED_FILES status=full line stays parseable', () => {
    for (const r of [
      admit(['package.json']),
      admit(['a.ts'], { everyTaskNarrowable: false }),
      admit(['a.ts'], { affectedFileCount: 0 }),
    ]) {
      expect(r.admitted).toBe(false);
      if (!r.admitted) {
        expect(`RELATED_AFFECTED_FILES status=full reason=${r.reason}`).toMatch(
          /^RELATED_AFFECTED_FILES status=full reason=\S+$/,
        );
      }
    }
  });
});

describe('affected-tests.mjs wiring (D-129 item 1)', () => {
  const code = stripCommentsAndStrings(readFileSync(join(ROOT, 'scripts/affected-tests.mjs'), 'utf8'));
  const start = code.indexOf('exactRadiusAdmission(');
  const block = code.slice(start, code.indexOf('checkpointTargetedReVerdictSelection =', start));

  it('decides the exact radius through exactRadiusAdmission over the real changed-path set', () => {
    expect(start).toBeGreaterThan(-1);
    expect(block).toContain('invariantGuardChangedPaths()');
  });

  it('no longer refuses the exact radius merely because invariant guards were selected', () => {
    expect(block.length).toBeGreaterThan(0);
    expect(block).not.toContain('selectedInvariantGuards');
  });
});
