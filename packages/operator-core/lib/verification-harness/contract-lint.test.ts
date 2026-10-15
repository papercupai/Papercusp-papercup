/**
 * R-10 (expensive-verification-loops-2026-09-29, P-006): the contract lint fails when a
 * long-running harness outside its allowlist does not declare the verification-harness contract.
 *
 * Three layers, as the requirement's verification names them: a conforming fixture, a
 * non-conforming fixture, and the real tree (scripts/, papercusp-desktop/bin/ and bin/vm-rig/,
 * against contract-lint-allowlist.json). Runs as `lint:vh-contract`, which affected-tests attaches
 * to every change under those directories.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  collectHarnessSources,
  declaresContract,
  isLongRunningHarnessPath,
  lintHarnessContracts,
  loadContractLintAllowlist,
  measureNonConforming,
} from './contract-lint';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const CONFORMING_SH = `#!/usr/bin/env bash
set -euo pipefail
VH_SH="$ROOT/libs/generic/verification-harness/bin/vh.sh"
source "$VH_SH"
vh_phase setup ""
vh_phase check setup
vh_init my-drill "$(vh_default_root my-drill)" "$@"
vh_run setup phase_setup
vh_run check phase_check
vh_finish
`;

const NON_CONFORMING_SH = `#!/usr/bin/env bash
set -euo pipefail
echo "boot the rig"
ssh rig 'long step'
echo PASS
`;

/** Mentions the contract only in comments: must not count as declaring it. */
const COMMENT_ONLY_SH = `#!/usr/bin/env bash
# TODO: source libs/generic/verification-harness/bin/vh.sh
# vh_init my-drill "$ROOT"
echo PASS
`;

const CONFORMING_TS = `import { runHarness } from '@papercusp/verification-harness';
await runHarness({ contract, phases, evidenceRoot });
`;

describe('isLongRunningHarnessPath', () => {
  it('matches harness-named scripts by a whole name token', () => {
    for (const p of [
      'scripts/verify-tauri-headless.sh',
      'papercusp-desktop/bin/hive-git-drill.sh',
      'papercusp-desktop/bin/linux-fresh-install-e2e.sh',
      'papercusp-desktop/bin/two-instance-merge-smoke.sh',
      'scripts/flake-soak.sh',
      'scripts/verify-identities-r3.mjs',
      'papercusp-desktop/bin/vm-rig/hive-git-physical-scenario.sh',
    ]) {
      expect(isLongRunningHarnessPath(p), p).toBe(true);
    }
  });

  it('ignores tests, self-tests, type declarations and non-harness names', () => {
    for (const p of [
      'papercusp-desktop/bin/release-local.sh',
      'papercusp-desktop/bin/lib/release-artifacts.selftest.sh',
      'scripts/verify-identities-r4.d.mts',
      'scripts/verify-thing.test.ts',
      'scripts/bench-release-task-reuse.ts',
      'scripts/reverify-notes.md',
      'scripts/verifyish.sh',
    ]) {
      expect(isLongRunningHarnessPath(p), p).toBe(false);
    }
  });
});

describe('declaresContract', () => {
  it('accepts a shell harness that sources vh.sh and calls vh_init', () => {
    expect(declaresContract('scripts/my-drill.sh', CONFORMING_SH)).toBe(true);
  });

  it('rejects a shell harness without the contract, and one that names it only in comments', () => {
    expect(declaresContract('scripts/my-drill.sh', NON_CONFORMING_SH)).toBe(false);
    expect(declaresContract('scripts/my-drill.sh', COMMENT_ONLY_SH)).toBe(false);
  });

  it('accepts a TS harness that runs through runHarness, and rejects an import without the call', () => {
    expect(declaresContract('scripts/verify-x.mts', CONFORMING_TS)).toBe(true);
    expect(declaresContract('scripts/verify-x.mts', `import { runHarness } from '@papercusp/verification-harness';\n`)).toBe(
      false,
    );
  });

  it('accepts a dynamically loaded source runner while still requiring an executable runHarness call', () => {
    const load = "const { runHarness } = await import('@papercusp/verification-harness');\n";
    expect(declaresContract('scripts/new-e2e.mjs', load + 'await runHarness({});')).toBe(true);
    expect(declaresContract('scripts/new-e2e.mjs', load)).toBe(false);
    expect(declaresContract('scripts/new-e2e.mjs', '// ' + load + 'await runHarness({});')).toBe(false);
    expect(declaresContract('scripts/new-e2e.mjs', "const x = import('@papercusp/other-runner');\nawait runHarness({});")).toBe(false);
  });
});

describe('lintHarnessContracts (fixtures)', () => {
  it('passes a conforming fixture harness', () => {
    expect(lintHarnessContracts([{ path: 'scripts/new-drill.sh', content: CONFORMING_SH }], {})).toEqual([]);
  });

  it('FAILS a non-conforming fixture harness that is not allowlisted (the R-10 falsifier)', () => {
    const findings = lintHarnessContracts([{ path: 'scripts/new-drill.sh', content: NON_CONFORMING_SH }], {});
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ path: 'scripts/new-drill.sh', reason: 'missing-contract' });
    expect(findings[0]!.detail).toContain('vh.sh');
  });

  it('passes a non-conforming harness only while it is allowlisted with a reason', () => {
    const src = [{ path: 'scripts/old-smoke.sh', content: NON_CONFORMING_SH }];
    expect(lintHarnessContracts(src, { 'scripts/old-smoke.sh': 'predates the contract' })).toEqual([]);
    expect(lintHarnessContracts(src, { 'scripts/old-smoke.sh': '  ' })).toEqual([
      expect.objectContaining({ path: 'scripts/old-smoke.sh', reason: 'allowlist-entry-stale' }),
    ]);
  });

  it('keeps the allowlist shrink-only: a conforming or vanished entry is a finding', () => {
    const findings = lintHarnessContracts([{ path: 'scripts/old-smoke.sh', content: CONFORMING_SH }], {
      'scripts/old-smoke.sh': 'predates the contract',
      'scripts/deleted-drill.sh': 'predates the contract',
    });
    expect(findings.map((f) => [f.path, f.reason])).toEqual([
      ['scripts/deleted-drill.sh', 'allowlist-entry-stale'],
      ['scripts/old-smoke.sh', 'allowlisted-but-conforming'],
    ]);
  });

  it('ignores scripts that are not harness-named', () => {
    expect(lintHarnessContracts([{ path: 'scripts/gen-docs.sh', content: NON_CONFORMING_SH }], {})).toEqual([]);
  });
});

describe('the real tree', () => {
  it('finds the harness population (positive control: the two adopted shell harnesses conform)', () => {
    const sources = collectHarnessSources(REPO_ROOT);
    const byPath = new Map(sources.map((s) => [s.path, s]));
    // Without these the scan found nothing and a clean result below would be vacuous.
    for (const adopted of ['scripts/verify-tauri-headless.sh', 'papercusp-desktop/bin/hive-git-drill.sh']) {
      const src = byPath.get(adopted);
      expect(src, `${adopted} missing from the scan`).toBeDefined();
      expect(declaresContract(adopted, src!.content), `${adopted} no longer declares the contract`).toBe(true);
    }
    expect(sources.length).toBeGreaterThan(10);
  });

  it('has no harness outside the allowlist without the contract, and no stale allowlist entry', () => {
    const allowlist = loadContractLintAllowlist();
    const findings = lintHarnessContracts(collectHarnessSources(REPO_ROOT), allowlist);
    const hint =
      findings.length === 0
        ? ''
        : `\n${findings.map((f) => `  ${f.reason}  ${f.path}: ${f.detail}`).join('\n')}\n` +
          `Adopt the contract (preferred), or, for a pre-existing harness only, re-seed ` +
          `contract-lint-allowlist.json from the live non-conforming set:\n${JSON.stringify(
            measureNonConforming(REPO_ROOT),
          )}`;
    expect(findings, hint).toEqual([]);
  });
});
