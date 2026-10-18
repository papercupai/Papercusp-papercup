/**
 * lint:tsc gate logic (audit P-073 / EI-104; per-file migration P-010 / WI-4535):
 *   - per-file baseline: a file above ITS baseline is a NEW, ATTRIBUTED regression,
 *   - --mine scopes the failure to files the caller changed (peer drift is reported, not gated),
 *   - ratchet-only-down per file on --update,
 *   - hard-fail on TS1xxx diagnostics regardless of counts,
 *   - per-file error attribution from raw tsc output.
 *
 * The script's pure functions are imported directly (same pattern as apps/operator's
 * psu-pty-host / ptool script tests).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import ts from 'typescript';
import { DEFAULT_UNIT_TEST_TIMEOUT_MS } from '@papercusp/test-config/vitest-config';
import { filesDependingOnChangedModules, diagnosticFilesDependingOnChangedTypes, checkedSetFor } from '../../../scripts/lib/tsc-service.mjs';

it('includes executable .mts scripts in the root scripts TypeScript project', () => {
  const configPath = fileURLToPath(new URL('../../../scripts/tsconfig.json', import.meta.url));
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  expect(loaded.error).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(configPath), undefined, configPath);
  expect(parsed.errors).toEqual([]);
  expect(parsed.fileNames).toContain(fileURLToPath(new URL('../../../scripts/run-carry-cohort.mts', import.meta.url)));
});
// eslint-disable-next-line import/no-relative-packages
import {
  parseTscErrors,
  normalizeDiagnosticPath,
  normalizeTscErrorPaths,
  syntaxBrokenFiles,
  countByFile,
  parseExplicitFiles,
  decidePerFile,
  relatedSourceFiles,
  filesModifiedDuringRun,
  effectiveBaselineByFile,
  exportedTypeNames,
  filesReferencingTypeNames,
  diagnosticFilesReferencingTypeNames,
  formatAttributionHeadline,
  formatNewFileGuidance,
  formatStandingRedRow,
  formatStandingRedFooter,
  partitionNewFilesByLiveEdit,
  partitionEntriesByLiveEdit,
  partitionBrokenFilesByLiveEdit,
  diagnosticLinesForFiles,
  formatRegressedFileDiagnostics,
  REGRESSION_DIAGNOSTIC_MAX_PER_FILE,
  ALL_ERRORS_FLAG,
  diagnosticCapFromArgv,
  partitionStandingByCommitRecency,
  formatLandingRaceCaveat,
  LANDING_RACE_WINDOW_SEC,
  isUnchangedForAttribution,
  TSC_COMMAND,
  TSC_PREFLIGHT_COMMAND,
  projectPrefixFromTscCommand,
  normalizeExplicitFilesForProject,
  partitionFilesByCoverage,
  suggestTypecheckGate,
  formatUncoveredFilesBanner,
  discoverSiblingTypecheckGates,
  coveragePrefixesFromGateModule,
  gateCoveringFile,
  coalesceWatermarkFor,
  declarationFilesFromConfig,
  lintTscScopeFromArgv,
  formatLintTscResultMarker,
  mergeRatchetIntoBaseline,
  MID_INSTALL_DIAGNOSTIC_MIN,
  parseMissingModuleDiagnostics,
  packageNameFromModuleSpecifier,
  detectUnextractedDependencyDiagnostics,
  formatMidInstallWarning,
} from '../../../scripts/lint-tsc.mjs';
// eslint-disable-next-line import/no-relative-packages
import {
  TSC_COMMAND as OPERATOR_VITE_TSC_COMMAND,
  FOREIGN_BASELINES,
} from '../../../scripts/lint-tsc-operator-vite.mjs';
// eslint-disable-next-line import/no-relative-packages
import {
  TSC_HEAP_MB,
  pcHeavyCompileArgv,
  resolvePinnedTscBin,
  resolvePinnedTscCommand,
  tscChildEnv,
  collectAutoTypecheckRoutes,
  runAutoTypecheckRoutes,
  workspaceTypecheckArgs,
  formatLintTscRunStamp,
  gitHeadShaForLintTsc,
  writeLintTscRunMarker,
  toolchainFailureExitCode,
  TOOLCHAIN_FAILURE_EXIT_CODE,
} from '../../../scripts/lib/tsc-baseline-gate.mjs';

describe('typecheck mid-install diagnostics (EI-19366483607548056)', () => {
  const OUTPUT = [
    "packages/operator-core/lib/voice-node/voice-relay.ts(110,31): error TS2307: Cannot find module 'hyperdht' or its corresponding type declarations.",
    "packages/operator-core/lib/voice-node/voice-relay.ts(114,34): error TS7016: Could not find a declaration file for module 'blind-relay'. '/repo/node_modules/blind-relay/index.js' implicitly has an 'any' type.",
    "packages/operator-core/lib/other.ts(1,1): error TS2307: Cannot find module '@not-a-dependency' or its corresponding type declarations.",
  ].join('\n');

  it('parses only module-resolution diagnostics and preserves their file/code/module fields', () => {
    expect(parseMissingModuleDiagnostics(OUTPUT)).toEqual([
      { file: 'packages/operator-core/lib/voice-node/voice-relay.ts', code: 'TS2307', module: 'hyperdht' },
      { file: 'packages/operator-core/lib/voice-node/voice-relay.ts', code: 'TS7016', module: 'blind-relay' },
      { file: 'packages/operator-core/lib/other.ts', code: 'TS2307', module: '@not-a-dependency' },
    ]);
  });

  it('normalizes scoped and subpath specifiers without treating relative imports as packages', () => {
    expect(packageNameFromModuleSpecifier('@scope/pkg/subpath.js')).toBe('@scope/pkg');
    expect(packageNameFromModuleSpecifier('hyperdht/testnet.js')).toBe('hyperdht');
    expect(packageNameFromModuleSpecifier('./local.js')).toBeNull();
  });

  it('requires the repeated-diagnostic floor and a matching dependency-doctor miss', () => {
    expect(MID_INSTALL_DIAGNOSTIC_MIN).toBe(2);
    expect(
      detectUnextractedDependencyDiagnostics({
        tscOutput: OUTPUT,
        missing: [
          { dep: 'hyperdht', workspace: 'packages/operator-core' },
          { dep: 'blind-relay', workspace: 'packages/operator-core' },
        ],
      }),
    ).toMatchObject({
      dependencies: ['hyperdht', 'blind-relay'],
      diagnostics: [
        { code: 'TS2307', module: 'hyperdht' },
        { code: 'TS7016', module: 'blind-relay' },
      ],
    });
    expect(
      detectUnextractedDependencyDiagnostics({
        tscOutput: OUTPUT.split('\n')[0],
        missing: [{ dep: 'hyperdht', workspace: 'packages/operator-core' }],
      }),
    ).toBeNull();
    expect(
      detectUnextractedDependencyDiagnostics({
        tscOutput: OUTPUT,
        missing: [{ dep: '@not-a-dependency', workspace: 'packages/operator-core' }],
      }),
    ).toBeNull();
  });

  it('formats the shared suspected-mid-install marker without claiming a pass', () => {
    const signal = detectUnextractedDependencyDiagnostics({
      tscOutput: OUTPUT,
      missing: [{ dep: 'hyperdht' }, { dep: 'blind-relay' }],
    });
    expect(signal).not.toBeNull();
    const lines = formatMidInstallWarning({ label: 'operator-core', ...signal! });
    expect(lines[0]).toContain('TEST_FILE_MID_INSTALL_SUSPECTED');
    expect(lines[0]).toContain('tscDiagnostics=2');
    expect(lines[1]).toContain('doctor:deps=DECLARED_DEPS_UNEXTRACTED');
    expect(lines[2]).toContain('remains non-zero');
  });
});

describe('LINT_TSC_RESULT completion marker (EI-19395061642732083)', () => {
  // This gate is the repo's MANDATED post-edit check and takes ~150s — past the agent Bash
  // tool's 120s DEFAULT. A SIGTERM'd run prints partial output and stops, so the usual
  // caller idiom (`... | tail -20`, or `grep <my-file>`) shows nothing alarming, which is
  // INDISTINGUISHABLE from "clean". The marker makes a completed run self-declare, so its
  // ABSENCE means UNMEASURED. Verified live 2026-08-03: a run killed at 20s (exit 124) left
  // a 139-byte log with no marker, while a completed run emitted status=regressed.
  it('derives status from the exit code the gate actually exited with', () => {
    expect(formatLintTscResultMarker({ label: 'operator-core', scope: 'files', code: 0 })).toBe(
      'LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean',
    );
    expect(formatLintTscResultMarker({ label: 'operator-core', scope: 'all', code: 1 })).toBe(
      'LINT_TSC_RESULT label=operator-core scope=all exit=1 status=regressed',
    );
    // Anything else is neither clean nor a normal gate failure — it must not read as either.
    expect(formatLintTscResultMarker({ label: 'x', scope: 'mine', code: 143 })).toContain(
      'status=error(143)',
    );
  });

  it('marks a delegated verdict as routed instead of falsely claiming this gate compiled the files', () => {
    expect(
      formatLintTscResultMarker({
        label: 'operator-core',
        scope: 'files',
        code: 0,
        routed: true,
      }),
    ).toBe('LINT_TSC_RESULT label=operator-core scope=files exit=0 status=routed');
    expect(formatLintTscResultMarker({
      label: 'operator-core', scope: 'files', code: 0, routed: true, filesUnchecked: 1,
    })).toBe('LINT_TSC_RESULT label=operator-core scope=files exit=0 status=partial filesUnchecked=1');
    expect(
      formatLintTscResultMarker({
        label: 'operator-core',
        scope: 'files',
        code: 1,
        filesUnchecked: 1,
        routed: true,
      }),
    ).toContain('status=routed-failed');
  });

  it('never reports a non-zero exit as clean — the whole point of the marker', () => {
    for (const code of [1, 2, 124, 137, 143]) {
      const marker = formatLintTscResultMarker({ label: 'operator-core', scope: 'all', code });
      expect(marker).not.toContain('status=clean');
    }
  });

  it('marks a regression observed across a concurrent source edit as inconclusive', () => {
    const marker = formatLintTscResultMarker({
      label: 'operator-core',
      scope: 'all',
      code: 1,
      concurrentEditInconclusive: true,
    });
    expect(marker).toBe(
      'LINT_TSC_RESULT label=operator-core scope=all exit=1 status=inconclusive-concurrent-edit',
    );
    expect(marker).not.toContain('status=regressed');
  });

  it('keeps abnormal exits as errors even when the concurrent-edit flag is set', () => {
    for (const code of [2, 124, 137, 143]) {
      expect(
        formatLintTscResultMarker({
          label: 'operator-core',
          scope: 'all',
          code,
          concurrentEditInconclusive: true,
        }),
      ).toContain(`status=error(${code})`);
    }
  });

  // EI-21467670625776948 — the FOURTH exit-1 shape: the gen:declarations preflight aborted on a
  // file the caller never touched (routinely a peer's in-flight edit — the preflight compiles the
  // whole declarations project), so ZERO of the caller's files were measured. That run printed
  // `status=regressed`, which is a verdict about the caller's work. These pin the distinct token.
  describe('distinguishes "the preflight aborted" from a real regression', () => {
    it('reports preflight-failed, NOT regressed, when the preflight aborted before any measurement', () => {
      const marker = formatLintTscResultMarker({
        label: 'operator-core',
        scope: 'all',
        code: 1,
        preflightFailed: true,
      });
      expect(marker).toBe(
        'LINT_TSC_RESULT label=operator-core scope=all exit=1 status=preflight-failed',
      );
      // The failure contract is deliberately UNCHANGED — non-zero still means "did not pass".
      expect(marker).toContain('exit=1');
      expect(marker).not.toContain('status=regressed');
    });

    it('still reports a real regression as regressed when the preflight succeeded', () => {
      expect(
        formatLintTscResultMarker({
          label: 'operator-core',
          scope: 'all',
          code: 1,
          preflightFailed: false,
        }),
      ).toContain('status=regressed');
    });

    it('cannot make a failing run look clean, nor a clean run look failed', () => {
      expect(
        formatLintTscResultMarker({ label: 'x', scope: 'all', code: 0, preflightFailed: true }),
      ).toBe('LINT_TSC_RESULT label=x scope=all exit=0 status=clean');
      for (const code of [1, 2, 124, 137, 143]) {
        expect(
          formatLintTscResultMarker({ label: 'x', scope: 'all', code, preflightFailed: true }),
        ).not.toContain('status=clean');
      }
    });

    it('leaves an abnormal-termination code reading as an error, not preflight-failed', () => {
      for (const code of [2, 124, 137, 143]) {
        expect(
          formatLintTscResultMarker({ label: 'x', scope: 'all', code, preflightFailed: true }),
        ).toContain(`status=error(${code})`);
      }
    });

    it('wins over nothingTypechecked — the more specific claim about why nothing was measured', () => {
      expect(
        formatLintTscResultMarker({
          label: 'x',
          scope: 'all',
          code: 1,
          preflightFailed: true,
          nothingTypechecked: true,
        }),
      ).toContain('status=preflight-failed');
    });
  });

  // EI-20072775668558359 — the gate exits 1 for TWO different reasons, and the machine-readable
  // field is the one callers grep. Calling "nothing was typechecked" a REGRESSION is a false
  // alarm: read literally it sends someone hunting a type error that does not exist, and once
  // learned as "regressed can mean nothing ran" it corrodes the token exactly when a regression
  // IS real. Most edits here are NOT in operator-core, so an out-of-scope `--files=` run is a
  // common shape. These assertions pin the two apart.
  describe('distinguishes "nothing was typechecked" from a real regression', () => {
    it('reports out-of-scope, NOT regressed, when the run compiled none of the named files', () => {
      const marker = formatLintTscResultMarker({
        label: 'operator-core',
        scope: 'files',
        code: 1,
        nothingTypechecked: true,
      });
      expect(marker).toBe(
        'LINT_TSC_RESULT label=operator-core scope=files exit=1 status=out-of-scope',
      );
      // The failure contract is deliberately UNCHANGED — non-zero still means "did not pass".
      expect(marker).toContain('exit=1');
      expect(marker).not.toContain('status=regressed');
    });

    it('still reports a real regression as regressed — the flag must not swallow the common case', () => {
      expect(
        formatLintTscResultMarker({ label: 'operator-core', scope: 'files', code: 1 }),
      ).toContain('status=regressed');
      expect(
        formatLintTscResultMarker({
          label: 'operator-core',
          scope: 'files',
          code: 1,
          nothingTypechecked: false,
        }),
      ).toContain('status=regressed');
    });

    // The drift the formatter's own note warns about: a refinement flag must never be able to
    // turn a FAILING run into a passing one. code===0 wins unconditionally.
    it('cannot make a failing run look clean, nor a clean run look failed', () => {
      expect(
        formatLintTscResultMarker({
          label: 'x',
          scope: 'all',
          code: 0,
          nothingTypechecked: true,
        }),
      ).toBe('LINT_TSC_RESULT label=x scope=all exit=0 status=clean');
      for (const code of [1, 2, 124, 137, 143]) {
        expect(
          formatLintTscResultMarker({ label: 'x', scope: 'all', code, nothingTypechecked: true }),
        ).not.toContain('status=clean');
      }
    });

    it('leaves an abnormal-termination code reading as an error, not out-of-scope', () => {
      // A SIGTERM'd / OOM'd run is UNMEASURED. It must not borrow the tidy out-of-scope label
      // just because the flag happened to be set before the process died — so the refinement is
      // scoped to exit 1 (the gate's own considered failure) and abnormal codes always win.
      for (const code of [2, 124, 137, 143]) {
        expect(
          formatLintTscResultMarker({ label: 'x', scope: 'files', code, nothingTypechecked: true }),
        ).toContain(`status=error(${code})`);
      }
      expect(
        formatLintTscResultMarker({ label: 'x', scope: 'files', code: 143 }),
      ).toContain('status=error(143)');
    });
  });

  // EI-20712456514085524 — the PARTIAL case. `nothingTypechecked` above pinned the ALL-uncovered
  // run; the mixed run (some named files in-project, some outside) took the other branch, exited
  // 0 because the covered verdict is genuinely true, and reported `status=clean`. Same
  // false-coverage failure as the all-uncovered branch, through the door beside it. Repro: four
  // files, two operator-core + two packages/agent-mcp, printed `exit=0 status=clean` while two of
  // them were never compiled.
  describe('reports PARTIAL coverage so a scoped pass cannot read as coverage of every named file', () => {
    it('reports partial + the count when some named files were never compiled', () => {
      expect(
        formatLintTscResultMarker({
          label: 'operator-core',
          scope: 'files',
          code: 0,
          filesUnchecked: 2,
        }),
      ).toBe('LINT_TSC_RESULT label=operator-core scope=files exit=0 status=partial filesUnchecked=2');
    });

    // THE LOAD-BEARING ASSERTION, and the reason the token is `partial` rather than
    // `clean-partial`: the established consumer idiom in this repo is a SUBSTRING grep
    // (`grep -q 'status=clean'`, mirroring TEST_FILE_RESULT). A `clean-partial` token would
    // satisfy that grep and reintroduce the exact misread this fix exists to kill.
    it('cannot satisfy a substring grep for status=clean', () => {
      const marker = formatLintTscResultMarker({
        label: 'operator-core',
        scope: 'files',
        code: 0,
        filesUnchecked: 1,
      });
      expect(marker).not.toContain('status=clean');
      expect(marker).toContain('filesUnchecked=1');
    });

    it('still reports exactly status=clean when every named file was covered', () => {
      // Additive for honest callers: full coverage is unchanged, including the explicit zero.
      for (const filesUnchecked of [0, undefined]) {
        expect(
          formatLintTscResultMarker({
            label: 'operator-core',
            scope: 'files',
            code: 0,
            filesUnchecked,
          }),
        ).toBe('LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean');
      }
    });

    // "3 files regressed" and "2 were never looked at" are INDEPENDENT facts. Suppressing the
    // second because the first is louder is how a caller fixes the named files, re-runs to green,
    // and ships the unexamined ones.
    it('still reports unchecked files alongside a real regression', () => {
      const marker = formatLintTscResultMarker({
        label: 'operator-core',
        scope: 'files',
        code: 1,
        filesUnchecked: 2,
      });
      expect(marker).toContain('status=regressed');
      expect(marker).toContain('filesUnchecked=2');
    });

    // The same drift rule the `nothingTypechecked` note states, in the other direction: a
    // coverage refinement may narrow what a PASS CLAIMS, but it must never change the pass/fail
    // contract itself. The exit code is what CI branches on.
    it('never changes the exit code — partial is a narrowed pass, not a new failure', () => {
      expect(
        formatLintTscResultMarker({ label: 'x', scope: 'files', code: 0, filesUnchecked: 5 }),
      ).toContain('exit=0');
      // And it must not dilute the all-uncovered verdict, which is a genuine FAILURE.
      const fatal = formatLintTscResultMarker({
        label: 'x',
        scope: 'files',
        code: 1,
        nothingTypechecked: true,
        filesUnchecked: 3,
      });
      expect(fatal).toContain('status=out-of-scope');
      expect(fatal).toContain('exit=1');
      expect(fatal).not.toContain('status=partial');
    });

    // A negative/NaN count must not manufacture a `partial` verdict out of a bad caller.
    it('ignores a non-positive or non-finite count rather than inventing partial coverage', () => {
      for (const filesUnchecked of [0, -1, Number.NaN]) {
        expect(
          formatLintTscResultMarker({ label: 'x', scope: 'files', code: 0, filesUnchecked }),
        ).toBe('LINT_TSC_RESULT label=x scope=files exit=0 status=clean');
      }
    });

    // EXECUTION, not a source-text regex. Everything above tests the pure formatter, which is
    // true only if the GATE actually stamps the count — a `readFileSync` + regex assertion
    // cannot tell live wiring from a comment that mentions it, and cannot see reachability at
    // all. Runnable here because the coverage decision is a pure path comparison made BEFORE
    // the ~150s compile: the all-uncovered path reaches its verdict in ~250ms. The path is a
    // stable, tracked repository file outside every typecheck gate, so explicit-path validation
    // accepts it while coverage still proves the all-uncovered branch.
    it('stamps the count from a REAL gate run, not just in the formatter', () => {
      const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
      let stdout: string;
      try {
        stdout = execFileSync(
          'node',
          [
            join(repoRoot, 'scripts/lint-tsc.mjs'),
            '--files=CLAUDE.md',
          ],
          { cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe' },
        );
      } catch (err) {
        // exit 1 IS the correct outcome for an all-uncovered run; the marker rides the exit
        // hook, so it is on stdout either way.
        stdout = String((err as { stdout?: string }).stdout ?? '');
      }
      expect(stdout).toContain('LINT_TSC_RESULT');
      expect(stdout).toContain('status=out-of-scope');
      expect(stdout).toContain('filesUnchecked=1');
    });
  });

  it('reports the scope, so a --files verdict is never mistaken for a whole-project one', () => {
    expect(lintTscScopeFromArgv([])).toBe('all');
    expect(lintTscScopeFromArgv(['--mine'])).toBe('mine');
    expect(lintTscScopeFromArgv(['--files=packages/operator-core/lib/a.ts'])).toBe('files');
    expect(lintTscScopeFromArgv(['--files', 'packages/operator-core/lib/a.ts'])).toBe('files');
    // --update MUTATES the baseline rather than judging against it, so it LEADS the label.
    // EI-19444246913245434: it used to REPLACE the scope flag beside it, so a run scoped to a
    // handful of files announced itself as a whole-project `scope=update` — the exact "a --files
    // verdict mistaken for a whole-project one" confusion this test exists to prevent, reachable
    // through the one combination it did not cover. Both facts are now reported.
    expect(lintTscScopeFromArgv(['--update', '--mine'])).toBe('update:mine');
  });

  it('is wired to process.on("exit") — not stamped per exit site, which a new one could skip', () => {
    // There are nine-plus `process.exit(...)` sites in the gate. Stamping each would let a
    // tenth silently opt out, and riding the exit hook is ALSO what makes the marker
    // impossible to print on SIGTERM/SIGKILL (Node runs no exit handler for those) — which
    // is precisely the property that makes absence meaningful. Pin the wiring.
    const gateSource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/lib/tsc-baseline-gate.mjs'),
      'utf8',
    );
    expect(gateSource).toMatch(/process\.on\(\s*['"]exit['"]/);
    expect(gateSource).toContain('formatLintTscResultMarker');
  });
});

describe('concurrent-edit regression guard (EI-20211153048499132)', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('walks local imports to identify a regression dependency cone', () => {
    dir = mkdtempSync(join(tmpdir(), 'tsc-cone-'));
    writeFileSync(join(dir, 'entry.ts'), "import { value } from './lib/value';\nexport const answer = value;\n");
    mkdirSync(join(dir, 'lib'), { recursive: true });
    writeFileSync(join(dir, 'lib/value.ts'), 'export const value = 42;\n');
    expect([...relatedSourceFiles({ root: dir, files: ['entry.ts'] })].sort()).toEqual([
      'entry.ts',
      'lib/value.ts',
    ]);
  });

  it('reports a dependency file modified after the run start', () => {
    dir = mkdtempSync(join(tmpdir(), 'tsc-concurrent-'));
    const start = 1_700_000_000_000;
    writeFileSync(join(dir, 'entry.ts'), "import { value } from './lib/value';\nexport const answer = value;\n");
    mkdirSync(join(dir, 'lib'), { recursive: true });
    writeFileSync(join(dir, 'lib/value.ts'), 'export const value = 42;\n');
    utimesSync(join(dir, 'entry.ts'), (start - 1000) / 1000, (start - 1000) / 1000);
    utimesSync(join(dir, 'lib/value.ts'), (start + 1000) / 1000, (start + 1000) / 1000);
    expect(
      filesModifiedDuringRun({ root: dir, files: ['entry.ts'], runStartMs: start }),
    ).toEqual(['lib/value.ts']);
  });

  it('returns no concurrent edit when every dependency predates the run', () => {
    dir = mkdtempSync(join(tmpdir(), 'tsc-settled-'));
    writeFileSync(join(dir, 'entry.ts'), "import { value } from './lib/value';\nexport const answer = value;\n");
    mkdirSync(join(dir, 'lib'), { recursive: true });
    writeFileSync(join(dir, 'lib/value.ts'), 'export const value = 42;\n');
    const before = Date.now() + 1000;
    expect(filesModifiedDuringRun({ root: dir, files: ['entry.ts'], runStartMs: before })).toEqual([]);
  });

  it('a real gate run refuses to call a mid-run cross-file edit regressed', () => {
    dir = mkdtempSync(join(tmpdir(), 'tsc-concurrent-gate-'));
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
    const gateUrl = pathToFileURL(join(repoRoot, 'scripts/lib/tsc-baseline-gate.mjs')).href;
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/entry.ts'), "import { value } from './value';\nexport const answer = value;\n");
    writeFileSync(join(dir, 'src/value.ts'), 'export const value = 42;\n');
    writeFileSync(join(dir, 'baseline.json'), JSON.stringify({ files: { 'src/entry.ts': 0 } }));
    writeFileSync(
      join(dir, 'fake-tsc.mjs'),
      "import { appendFileSync } from 'node:fs';\n" +
        "appendFileSync('src/value.ts', '// edited during compile\\n');\n" +
        `console.log("src/entry.ts(1,10): error TS2305: Module './value' has no exported member 'value'.");\n` +
        'process.exit(1);\n',
    );
    writeFileSync(
      join(dir, 'run.mjs'),
      `import { runTscBaselineGate } from ${JSON.stringify(gateUrl)};\n` +
        `await runTscBaselineGate({ root: ${JSON.stringify(dir)}, ` +
        `tscCommand: ${JSON.stringify(`${process.execPath} ${join(dir, 'fake-tsc.mjs')}`)}, ` +
        `baselineFile: ${JSON.stringify(join(dir, 'baseline.json'))}, label: 'fixture', argv: [] });\n`,
    );

    let stdout = '';
    let stderr = '';
    try {
      execFileSync(process.execPath, [join(dir, 'run.mjs')], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      stdout = String((error as { stdout?: string }).stdout ?? '');
      stderr = String((error as { stderr?: string }).stderr ?? '');
    }
    expect(stdout).toContain('status=inconclusive-concurrent-edit');
    expect(stdout).not.toContain('status=regressed');
    expect(stderr).toContain('INCONCLUSIVE');
    expect(stderr).toContain('src/value.ts');
    expect(stderr).not.toContain('Fix the new errors');
  });
});

// WI-6554700010009284 — a compile that produced NO output is a toolchain failure: nothing was
// measured. It used to `process.exit(1)`, and exit 1 is the gate's CONSIDERED failure, so the
// LINT_TSC_RESULT marker told the caller `status=regressed` (observed when pc-heavy's detached
// scope could not reach the user D-Bus: PC_HEAVY_RESULT status=undetermined exit=75). The same
// exit-1 mislabel sat on three more never-measured paths, pinned below: a crash whose output is
// a trace with no parseable diagnostics, an unreadable baseline, and a refused `--seed`.
describe('a toolchain, input or usage failure never reads as regressed (WI-6554700010009284)', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  // `baseline: null` writes no baseline file. `compilerStdout` is printed by the fake compiler
  // before it exits with `compilerExit`.
  function runGateWithFakeCompiler({
    compilerExit,
    compilerStdout = '',
    baseline = { files: {} },
    argv = [],
    foreignBaselines,
  }: {
    compilerExit: number;
    compilerStdout?: string;
    baseline?: { files: Record<string, number> } | null;
    argv?: string[];
    foreignBaselines?: { prefix: string; baselineFile: string; label: string }[];
  }) {
    dir = mkdtempSync(join(tmpdir(), 'tsc-toolchain-failure-'));
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
    const gateUrl = pathToFileURL(join(repoRoot, 'scripts/lib/tsc-baseline-gate.mjs')).href;
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/entry.ts'), 'export const answer = 42;\n');
    if (baseline !== null) writeFileSync(join(dir, 'baseline.json'), JSON.stringify(baseline));
    writeFileSync(
      join(dir, 'fake-tsc.mjs'),
      (compilerStdout ? `process.stdout.write(${JSON.stringify(compilerStdout)});\n` : '') +
        `process.exit(${compilerExit});\n`,
    );
    writeFileSync(
      join(dir, 'run.mjs'),
      `import { runTscBaselineGate } from ${JSON.stringify(gateUrl)};\n` +
        `await runTscBaselineGate({ root: ${JSON.stringify(dir)}, ` +
        `tscCommand: ${JSON.stringify(`${process.execPath} ${join(dir, 'fake-tsc.mjs')}`)}, ` +
        `baselineFile: ${JSON.stringify(join(dir, 'baseline.json'))}, label: 'fixture', ` +
        `argv: ${JSON.stringify(argv)}` +
        (foreignBaselines ? `, foreignBaselines: ${JSON.stringify(foreignBaselines)}` : '') +
        ` });\n`,
    );
    let status: number | null = 0;
    let stdout = '';
    let stderr = '';
    try {
      stdout = execFileSync(process.execPath, [join(dir, 'run.mjs')], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      const failed = error as { status?: number | null; stdout?: string; stderr?: string };
      status = failed.status ?? null;
      stdout = String(failed.stdout ?? '');
      stderr = String(failed.stderr ?? '');
    }
    return { status, stdout, stderr };
  }

  function runGateWithSilentCompiler(compilerExit: number) {
    return runGateWithFakeCompiler({ compilerExit });
  }

  // Without this, every `not.toContain('status=regressed')` below could pass vacuously.
  it('positive control: a real new diagnostic still exits 1 as regressed', () => {
    const { status, stdout } = runGateWithFakeCompiler({
      compilerExit: 1,
      compilerStdout: "src/entry.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.\n",
    });
    expect(status).toBe(1);
    expect(stdout).toContain('status=regressed');
  });

  it("passes the compiler's own abnormal exit through (pc-heavy EX_TEMPFAIL 75 -> error(75))", () => {
    const { status, stdout, stderr } = runGateWithSilentCompiler(75);
    expect(status).toBe(75);
    expect(stdout).toContain('status=error(75)');
    expect(stdout).not.toContain('status=regressed');
    expect(stderr).toContain('toolchain failure');
  });

  it('a silent compiler that exits 1 still fails, but as error(70), never regressed', () => {
    const { status, stdout } = runGateWithSilentCompiler(1);
    expect(status).toBe(TOOLCHAIN_FAILURE_EXIT_CODE);
    expect(stdout).toContain(`status=error(${TOOLCHAIN_FAILURE_EXIT_CODE})`);
    expect(stdout).not.toContain('status=regressed');
  });

  it('toolchainFailureExitCode never returns 0 or 1 (pass / considered failure)', () => {
    expect(toolchainFailureExitCode({ status: 75 })).toBe(75);
    expect(toolchainFailureExitCode({ status: null, signal: 'SIGTERM' })).toBe(143);
    expect(toolchainFailureExitCode({ status: null, signal: 'SIGKILL' })).toBe(137);
    for (const child of [{}, { status: 0 }, { status: 1 }, { status: -1 }, { status: 300 }, { signal: 'NOT_A_SIGNAL' }]) {
      const code = toolchainFailureExitCode(child);
      expect(code).toBe(TOOLCHAIN_FAILURE_EXIT_CODE);
      expect(formatLintTscResultMarker({ label: 'x', scope: 'all', code })).toContain(`status=error(${code})`);
    }
  });

  // The OOM shape (WI-37485): tsc aborts with a V8 heap trace and no TS diagnostic. The trace makes
  // the output non-empty, so this reaches the zero-parseable-diagnostics guard, not the no-output one.
  it('a crash that prints only a heap trace fails with its own code (134), never regressed', () => {
    const { status, stdout, stderr } = runGateWithFakeCompiler({
      compilerExit: 134,
      compilerStdout:
        'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory\n',
    });
    expect(status).toBe(134);
    expect(stdout).toContain('status=error(134)');
    expect(stdout).not.toContain('status=regressed');
    expect(stderr).toContain('ZERO parseable diagnostics');
  });

  it('a crash trace with a plain exit 1 still fails, but as error(70), never regressed', () => {
    const { status, stdout } = runGateWithFakeCompiler({ compilerExit: 1, compilerStdout: 'Segmentation fault\n' });
    expect(status).toBe(TOOLCHAIN_FAILURE_EXIT_CODE);
    expect(stdout).toContain(`status=error(${TOOLCHAIN_FAILURE_EXIT_CODE})`);
    expect(stdout).not.toContain('status=regressed');
  });

  // Input and usage refusals judge nothing either: sysexits EX_NOINPUT (66) and EX_USAGE (64).
  it('an unreadable baseline file fails as error(66), never regressed', () => {
    const { status, stdout, stderr } = runGateWithFakeCompiler({ compilerExit: 0, baseline: null });
    expect(status).toBe(66);
    expect(stdout).toContain('status=error(66)');
    expect(stdout).not.toContain('status=regressed');
    expect(stderr).toContain('Failed to read baseline file');
  });

  it('--seed against a populated baseline is refused as error(64), never regressed', () => {
    const { status, stdout, stderr } = runGateWithFakeCompiler({
      compilerExit: 0,
      baseline: { files: { 'src/entry.ts': 1 } },
      argv: ['--seed'],
    });
    expect(status).toBe(64);
    expect(stdout).toContain('status=error(64)');
    expect(stdout).not.toContain('status=regressed');
    expect(stderr).toContain('--seed refused');
  });

  it('--seed with an unreadable owning baseline is refused as error(66), never regressed', () => {
    const { status, stdout, stderr } = runGateWithFakeCompiler({
      compilerExit: 0,
      argv: ['--seed'],
      foreignBaselines: [
        { prefix: 'src/', baselineFile: '/nonexistent-papercusp-fixture/owner-baseline.json', label: 'owner' },
      ],
    });
    expect(status).toBe(66);
    expect(stdout).toContain('status=error(66)');
    expect(stdout).not.toContain('status=regressed');
    expect(stderr).toContain('owning baseline(s) could not be read');
  });
});

// EI-19323399466378077 — a backgrounded run's log body is byte-identical whether it is 30 seconds
// or three hours old (WI-6951: a stale TSC_EXIT=1 log nearly reopened two already-fixed fixtures).
// filesystem mtime cannot disambiguate on this tree either, because git-sync commits on a
// schedule (the commit time is when the SWEEP ran, not when the edit landed). These pin the two
// places the run-start stamp now lives: the terminal LINT_TSC_RESULT line (what a `| tail -N`
// reads) and the pre-run LINT_TSC_RUN_STAMP banner (what survives a killed/hung run).
describe('run-start stamp on LINT_TSC_RESULT (EI-19323399466378077)', () => {
  it('is OMITTED when the caller does not supply it — every pre-existing call site stays byte-identical', () => {
    expect(formatLintTscResultMarker({ label: 'operator-core', scope: 'all', code: 0 })).toBe(
      'LINT_TSC_RESULT label=operator-core scope=all exit=0 status=clean',
    );
  });

  it('is APPENDED LAST, after filesUnchecked, when the caller supplies it', () => {
    const marker = formatLintTscResultMarker({
      label: 'operator-core',
      scope: 'all',
      code: 0,
      runStartIso: '2026-08-30T12:00:00.000Z',
      headSha: 'abc1234567',
    });
    expect(marker).toBe(
      'LINT_TSC_RESULT label=operator-core scope=all exit=0 status=clean at=2026-08-30T12:00:00.000Z head=abc1234567',
    );
  });

  it('appends after filesUnchecked, not before it, so status= stays a stable substring-grep target', () => {
    const marker = formatLintTscResultMarker({
      label: 'operator-core',
      scope: 'files',
      code: 0,
      filesUnchecked: 2,
      runStartIso: '2026-08-30T12:00:00.000Z',
      headSha: 'abc1234567',
    });
    expect(marker).toBe(
      'LINT_TSC_RESULT label=operator-core scope=files exit=0 status=partial filesUnchecked=2 ' +
        'at=2026-08-30T12:00:00.000Z head=abc1234567',
    );
  });

  it('reports head=unknown rather than fabricating a sha when git could not be read', () => {
    const marker = formatLintTscResultMarker({
      label: 'x',
      scope: 'all',
      code: 1,
      runStartIso: '2026-08-30T12:00:00.000Z',
      headSha: null,
    });
    expect(marker).toContain('head=unknown');
  });

  it('is wired into the exit hook alongside a run-start capture at function entry', () => {
    // Mirrors the sibling assertion above (line 469): pin the WIRING, not just the pure
    // formatter, so a future refactor cannot quietly stop passing the stamp through.
    const gateSource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/lib/tsc-baseline-gate.mjs'),
      'utf8',
    );
    expect(gateSource).toContain('runStartIso');
    expect(gateSource).toContain('gitHeadShaForLintTsc');
  });
});

describe('LINT_TSC_RUN_STAMP pre-run banner (EI-19323399466378077)', () => {
  it('names the run start, the HEAD it judged, and reports "all" when no --files scope was given', () => {
    const stamp = formatLintTscRunStamp({
      label: 'operator-core',
      runStartIso: '2026-08-30T12:00:00.000Z',
      headSha: 'abc1234567',
      scope: 'all',
      files: null,
    });
    expect(stamp).toBe(
      'LINT_TSC_RUN_STAMP label=operator-core at=2026-08-30T12:00:00.000Z head=abc1234567 scope=all files=all',
    );
  });

  it('lists each resolved --files path — the header a reader can compare against the caller\'s intent', () => {
    const stamp = formatLintTscRunStamp({
      label: 'operator-core',
      runStartIso: '2026-08-30T12:00:00.000Z',
      headSha: 'abc1234567',
      scope: 'files',
      files: ['packages/operator-core/lib/a.ts', 'packages/operator-core/lib/b.ts'],
    });
    expect(stamp).toContain('files=2');
    expect(stamp).toContain('packages/operator-core/lib/a.ts');
    expect(stamp).toContain('packages/operator-core/lib/b.ts');
  });

  it('reports head=unknown rather than fabricating a sha when git could not be read', () => {
    expect(
      formatLintTscRunStamp({
        label: 'x',
        runStartIso: '2026-08-30T12:00:00.000Z',
        headSha: null,
        scope: 'all',
        files: null,
      }),
    ).toContain('head=unknown');
  });
});

describe('gitHeadShaForLintTsc — never fabricates a sha it could not read', () => {
  it('reads a real short HEAD sha from this repo', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    expect(gitHeadShaForLintTsc(root)).toMatch(/^[0-9a-f]{7,10}$/);
  });

  it('returns null, never a fabricated value, when the directory is not a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'not-a-repo-'));
    try {
      expect(gitHeadShaForLintTsc(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('session-scoped lint:tsc run marker writer (EI-19421388108187854)', () => {
  const runStartIso = '2026-09-05T23:00:00.000Z';

  it('writes independent marker files for concurrent sessions without a legacy fallback', () => {
    const root = mkdtempSync(join(tmpdir(), 'lint-tsc-session-marker-'));
    const files = ['packages/operator-core/lib/a.ts'];
    try {
      expect(
        writeLintTscRunMarker({
          root,
          label: 'operator-core',
          runStartIso,
          headSha: 'abc1234567',
          scope: 'files',
          files,
          sessionId: 'session-a',
        }),
      ).toBe(true);
      // A peer writes its own marker in the same checkout; it must not replace A's
      // standing verdict or cause the hook to read the peer's file set.
      expect(
        writeLintTscRunMarker({
          root,
          label: 'operator-core',
          runStartIso: '2026-09-05T23:01:00.000Z',
          headSha: 'def7654321',
          scope: 'files',
          files: ['packages/operator-core/lib/peer.ts'],
          sessionId: 'session-b',
        }),
      ).toBe(true);

      const scratch = join(root, '.papercusp', 'scratch');
      const own = JSON.parse(
        readFileSync(join(scratch, 'lint-tsc-last-run.session-a.json'), 'utf8'),
      );
      const peer = JSON.parse(
        readFileSync(join(scratch, 'lint-tsc-last-run.session-b.json'), 'utf8'),
      );
      expect(own).toMatchObject({
        label: 'operator-core',
        at: runStartIso,
        atMs: Date.parse(runStartIso),
        head: 'abc1234567',
        scope: 'files',
        files: ['packages/operator-core/lib/a.ts'],
      });
      expect(peer).toMatchObject({
        at: '2026-09-05T23:01:00.000Z',
        files: ['packages/operator-core/lib/peer.ts'],
      });
      expect(files).toEqual(['packages/operator-core/lib/a.ts']);
      expect(existsSync(join(scratch, 'lint-tsc-last-run.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes verifier markers beside the independent receipt without changing the frozen source', () => {
    const container = mkdtempSync(join(tmpdir(), 'lint-tsc-verifier-marker-'));
    const root = join(container, 'frozen-source');
    const receipt = join(container, 'source-receipt.json');
    mkdirSync(root);
    writeFileSync(receipt, JSON.stringify({ sourceCommit: 'abc1234567' }));
    const previous = process.env.VERIFY_TAURI_SOURCE_RECEIPT;
    process.env.VERIFY_TAURI_SOURCE_RECEIPT = receipt;
    try {
      expect(writeLintTscRunMarker({ root, label: 'plugin-loader', runStartIso,
        headSha: 'abc1234567', scope: 'all', files: null, sessionId: 'verifier-a' })).toBe(true);
      expect(existsSync(join(root, '.papercusp'))).toBe(false);
      expect(JSON.parse(readFileSync(join(container, '.papercusp', 'scratch',
        'lint-tsc-last-run.verifier-a.json'), 'utf8'))).toMatchObject({
        label: 'plugin-loader', head: 'abc1234567', scope: 'all',
      });
      const invalidReceipt = join(root, 'source-receipt.json');
      writeFileSync(invalidReceipt, '{}');
      process.env.VERIFY_TAURI_SOURCE_RECEIPT = invalidReceipt;
      expect(writeLintTscRunMarker({ root, label: 'plugin-loader', runStartIso,
        headSha: 'abc1234567', scope: 'all', files: null, sessionId: 'verifier-b' })).toBe(false);
      expect(existsSync(join(root, '.papercusp'))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.VERIFY_TAURI_SOURCE_RECEIPT;
      else process.env.VERIFY_TAURI_SOURCE_RECEIPT = previous;
      rmSync(container, { recursive: true, force: true });
    }
  });

  it('refuses missing or unsafe session identities instead of writing a shared marker', () => {
    const root = mkdtempSync(join(tmpdir(), 'lint-tsc-session-marker-'));
    const input = {
      root,
      label: 'operator-core',
      runStartIso,
      headSha: null,
      scope: 'all',
      files: null,
    };
    try {
      for (const sessionId of [null, '', '../peer', 'session/peer']) {
        expect(writeLintTscRunMarker({ ...input, sessionId })).toBe(false);
      }
      expect(
        existsSync(join(root, '.papercusp', 'scratch', 'lint-tsc-last-run.json')),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('TSC_COMMAND (EI-487 regression guard)', () => {
  it('always measures fresh — never trusts a warm/stale incremental cache', () => {
    // A stale tsconfig.tsbuildinfo under-reports errors for files affected-but-
    // not-yet-reindexed (WI-4488). Under THIS script that under-report is worse
    // than a normal false-green: on `--update` it silently ratchets a file's
    // baseline DOWN to the incomplete count, so a later fully-fresh run (CI, or
    // the same file once its cache catches up) trips the gate on code that
    // already passed its author's own `lint:tsc` — the fleet-wide false red
    // EI-487 traced back to this flag being absent. Pin it so nobody removes it
    // as a "harmless" perf tweak without re-deriving why it's here.
    expect(TSC_COMMAND).toContain('--incremental false');
    expect(TSC_COMMAND).toContain('--noEmit');
  });

  it('refreshes enrolled generated declarations before the first compiler pass', () => {
    expect(TSC_PREFLIGHT_COMMAND).toBe('npm run gen:declarations');
  });
});

describe('typecheck preflight ordering (EI-21441555291852229)', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const gateUrl = pathToFileURL(join(repoRoot, 'scripts/lib/tsc-baseline-gate.mjs')).href;

  it('finishes the declaration refresh before launching tsc', () => {
    const root = mkdtempSync(join(tmpdir(), 'tsc-gate-preflight-'));
    try {
      const marker = join(root, 'declarations-ready');
      const baseline = join(root, 'baseline.json');
      writeFileSync(baseline, JSON.stringify({ files: {} }));
      writeFileSync(
        join(root, 'run.mjs'),
        `import { runTscBaselineGate } from ${JSON.stringify(gateUrl)};\n` +
          `await runTscBaselineGate({\n` +
          `  root: ${JSON.stringify(root)},\n` +
          `  preTscCommand: ${JSON.stringify(`printf ready > ${marker}`)},\n` +
          `  tscCommand: ${JSON.stringify(`test -f ${marker}`)},\n` +
          `  baselineFile: ${JSON.stringify(baseline)},\n` +
          `  label: 'preflight-order',\n` +
          `  argv: [],\n` +
          `});\n`,
      );

      const out = execFileSync(process.execPath, [join(root, 'run.mjs')], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
      expect(out).toContain('TSC preflight-order: 0 type errors');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('explicit --files path validation (EI-22438149246482169)', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const gateUrl = pathToFileURL(join(repoRoot, 'scripts/lib/tsc-baseline-gate.mjs')).href;

  function runGate({
    root,
    argv,
    preTscCommand,
    tscCommand,
  }: {
    root: string;
    argv: string[];
    preTscCommand: string;
    tscCommand: string;
  }): { out: string; code: number } {
    writeFileSync(
      join(root, 'run.mjs'),
      `import { runTscBaselineGate } from ${JSON.stringify(gateUrl)};\n` +
        `await runTscBaselineGate({\n` +
        `  root: ${JSON.stringify(root)},\n` +
        `  preTscCommand: ${JSON.stringify(preTscCommand)},\n` +
        `  tscCommand: ${JSON.stringify(tscCommand)},\n` +
        `  baselineFile: ${JSON.stringify(join(root, 'baseline.json'))},\n` +
        `  label: 'explicit-files',\n` +
        `  argv: ${JSON.stringify(argv)},\n` +
        `});\n`,
    );
    try {
      return {
        out: execFileSync(process.execPath, [join(root, 'run.mjs')], {
          encoding: 'utf8',
          stdio: 'pipe',
        }),
        code: 0,
      };
    } catch (e: any) {
      return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? -1 };
    }
  }

  it('fails a missing named path before preTscCommand or tsc can run', () => {
    const root = mkdtempSync(join(tmpdir(), 'tsc-gate-missing-explicit-file-'));
    try {
      mkdirSync(join(root, 'lib'), { recursive: true });
      writeFileSync(join(root, 'baseline.json'), JSON.stringify({ files: {} }));
      const preflightMarker = join(root, 'preflight-ran');
      const tscMarker = join(root, 'tsc-ran');
      const { out, code } = runGate({
        root,
        argv: ['--files=lib/does-not-exist.ts'],
        preTscCommand: `printf preflight > ${preflightMarker}`,
        tscCommand: `printf tsc > ${tscMarker}`,
      });

      expect(code).toBe(1);
      expect(out).toContain('LINT_TSC_RUN_STAMP');
      expect(out).toContain('lib/does-not-exist.ts');
      expect(out).toContain('missing/non-file');
      expect(out).toContain('status=preflight-failed');
      expect(existsSync(preflightMarker)).toBe(false);
      expect(existsSync(tscMarker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows existing named files through preTscCommand and tsc', () => {
    const root = mkdtempSync(join(tmpdir(), 'tsc-gate-existing-explicit-file-'));
    try {
      mkdirSync(join(root, 'lib'), { recursive: true });
      writeFileSync(join(root, 'lib/existing.ts'), 'export const value = 1;\n');
      writeFileSync(join(root, 'baseline.json'), JSON.stringify({ files: {} }));
      const preflightMarker = join(root, 'preflight-ran');
      const tscMarker = join(root, 'tsc-ran');
      const { out, code } = runGate({
        root,
        argv: ['--files=lib/existing.ts'],
        preTscCommand: `printf preflight > ${preflightMarker}`,
        tscCommand: `test -f ${preflightMarker} && printf tsc > ${tscMarker}`,
      });

      expect(code).toBe(0);
      expect(out).toContain('TSC explicit-files: 0 type errors');
      expect(out).toContain('status=clean');
      expect(readFileSync(preflightMarker, 'utf8')).toBe('preflight');
      expect(readFileSync(tscMarker, 'utf8')).toBe('tsc');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('per-project lint:tsc entrypoints (EI-21311288080670514)', () => {
  it('leaves compile admission to the shared gate instead of nesting pc-heavy wrappers', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
    const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};
    const perProjectGates = [
      'lint:tsc',
      'lint:tsc:operator-vite',
      'lint:tsc:orchestrator',
      'lint:tsc:operator',
      'lint:tsc:scripts',
      'typecheck',
    ];

    for (const name of perProjectGates) {
      expect(scripts[name], `${name} must be present`).toBeDefined();
      expect(scripts[name], `${name} must not acquire an outer pc-heavy wrapper`).not.toContain(
        'pc-heavy',
      );
      expect(scripts[name]).toMatch(/^node scripts\/lint-tsc(?:-[a-z-]+)?\.mjs$/);
    }

    // Workspace fan-out invokes each package's `typecheck` script from inside its own
    // aggregate pc-heavy reservation. Any workspace script that delegates to a shared
    // baseline gate must therefore leave admission to that gate too; otherwise the
    // aggregate reservation and the gate's compile reservation can deadlock when the
    // focused lane is clamped to one slot.
    for (const root of ['apps', 'packages']) {
      for (const entry of readdirSync(join(repoRoot, root), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const workspacePackage = join(repoRoot, root, entry.name, 'package.json');
        if (!existsSync(workspacePackage)) continue;
        const workspace = JSON.parse(readFileSync(workspacePackage, 'utf8')) as {
          scripts?: Record<string, string>;
        };
        const typecheck = workspace.scripts?.typecheck;
        if (!typecheck?.includes('lint-tsc')) continue;
        expect(typecheck, `${root}/${entry.name} typecheck must not nest pc-heavy`).not.toContain(
          'pc-heavy',
        );
      }
    }

    const submoduleWorkspace = join(
      repoRoot,
      'libs',
      'papercusp',
      'packages',
      'orchestrator',
      'package.json',
    );
    if (existsSync(submoduleWorkspace)) {
      const workspace = JSON.parse(readFileSync(submoduleWorkspace, 'utf8')) as {
        scripts?: Record<string, string>;
      };
      const typecheck = workspace.scripts?.typecheck;
      expect(typecheck, 'libs/papercusp orchestrator typecheck must be present').toBeDefined();
      expect(typecheck, 'libs/papercusp orchestrator typecheck must not nest pc-heavy').not.toContain(
        'pc-heavy',
      );
    }
  });
});

describe('pinned TypeScript CLI resolution (EI-21107417900847684)', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

  it('bypasses the ambient .bin slot and resolves the native TypeScript 7 package', () => {
    const pinned = resolvePinnedTscBin(repoRoot);
    expect(pinned).toContain('/node_modules/@typescript/native/bin/tsc');
    expect(execFileSync(process.execPath, [pinned, '--version'], { encoding: 'utf8' }).trim()).toBe(
      'Version 7.0.2',
    );
  });

  it('rewrites canonical npx tsc commands but preserves injected canned commands', () => {
    const rewritten = resolvePinnedTscCommand(
      repoRoot,
      'npx tsc -p packages/operator-core/tsconfig.json --noEmit',
    );
    expect(rewritten).toContain('/node_modules/@typescript/native/bin/tsc');
    expect(rewritten).not.toContain('npx tsc');

    const canned = 'cat /tmp/tsc-output.txt';
    expect(resolvePinnedTscCommand(repoRoot, canned)).toBe(canned);
  });
});

// WI-37503: `--incremental false` above is correct and stays — but it means the WHOLE
// program is built in memory every run, and with node's DEFAULT ~4GB old-space the
// operator-core compile (9013 files) OOM'd mid-flight and CRASHED the gate:
//   FATAL ERROR: Ineffective mark-compacts near heap limit … heap out of memory
//   Mark-Compact (reduce) 4086.9 (4109.7) -> 4068.3 (4086.9) MB
// It held the fleet gate as sole holder (verdict 2026-08-09T14:30:46Z, candidate
// 9f3c0024552a, GATE_HELD_BY entries=["lint:tsc"], all 22 test tasks passing). Before
// the crash guard landed, that same OOM read as "every file improved to 0 errors" and
// passed a candidate carrying a real TS2741 (WI-37485). So the heap is load-bearing for
// the gate's correctness, not a perf tweak — pin it.
describe('tsc child heap (WI-37503)', () => {
  it('raises the child V8 old-space ceiling above the ~4GB default that crashed the gate', () => {
    // NODE_OPTIONS must be cleared explicitly: this runner sets its own
    // --max-old-space-size, so an uncontrolled read would exercise the DEFER branch
    // below and silently never test the default at all (it did, first run).
    const prev = process.env.NODE_OPTIONS;
    delete process.env.NODE_OPTIONS;
    try {
      expect(TSC_HEAP_MB).toBeGreaterThan(4096);
      expect(tscChildEnv().NODE_OPTIONS).toBe(`--max-old-space-size=${TSC_HEAP_MB}`);
    } finally {
      if (prev !== undefined) process.env.NODE_OPTIONS = prev;
    }
  });

  it('DEFERS to a caller who pinned a LARGER size — never appends a second copy', () => {
    // node takes the LAST occurrence, so appending would silently override an
    // operator's deliberate pin. Deference is correct when they asked for MORE.
    const prev = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `--max-old-space-size=${TSC_HEAP_MB * 2}`;
    try {
      const env = tscChildEnv();
      expect(env.NODE_OPTIONS).toBe(`--max-old-space-size=${TSC_HEAP_MB * 2}`);
      expect(env.NODE_OPTIONS?.match(/--max-old-space-size/g)).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = prev;
    }
  });

  // WI-37450 REGRESSION GUARD — this is the case that froze the fleet gate for
  // ~10h across 11 consecutive reds, and NO test covered it: every assertion
  // above exercises either an EMPTY NODE_OPTIONS or a larger pin, while the gate
  // path always supplies a SMALLER one.
  //
  // green-checkpoint's buildGreenCheckpointEnv unconditionally pins
  // --max-old-space-size=GREEN_CHECKPOINT_FORK_HEAP_MB (4096) to stop 8 concurrent
  // TEST forks inheriting the bg-host's 128 GiB heap, then hands that same env to
  // runPostSuiteLegs -> `npm run lint:tsc`. A per-FORK cap is not a statement about
  // a single whole-program tsc compile, so it must be RAISED, not deferred to.
  it('RAISES a smaller inherited pin (the gate per-fork cap) instead of deferring to it', () => {
    const GATE_FORK_HEAP_MB = 4096; // GREEN_CHECKPOINT_FORK_HEAP_MB
    expect(GATE_FORK_HEAP_MB).toBeLessThan(TSC_HEAP_MB); // else this guard proves nothing
    const prev = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `--max-old-space-size=${GATE_FORK_HEAP_MB}`;
    try {
      const env = tscChildEnv();
      expect(env.NODE_OPTIONS).toBe(`--max-old-space-size=${TSC_HEAP_MB}`);
      // Still exactly one copy — the last-wins hazard the deference rule guarded.
      expect(env.NODE_OPTIONS?.match(/--max-old-space-size/g)).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = prev;
    }
  });

  it('raises a smaller pin in the SPACE-SEPARATED form too, preserving neighbours', () => {
    const prev = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--enable-source-maps --max-old-space-size 4096 --expose-gc';
    try {
      const env = tscChildEnv();
      expect(env.NODE_OPTIONS).toContain(`--max-old-space-size=${TSC_HEAP_MB}`);
      expect(env.NODE_OPTIONS).toContain('--enable-source-maps');
      expect(env.NODE_OPTIONS).toContain('--expose-gc');
      expect(env.NODE_OPTIONS).not.toContain('4096');
      expect(env.NODE_OPTIONS?.match(/--max-old-space-size/g)).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = prev;
    }
  });

  it('PRESERVES unrelated NODE_OPTIONS rather than clobbering them', () => {
    const prev = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--enable-source-maps';
    try {
      const env = tscChildEnv();
      expect(env.NODE_OPTIONS).toContain('--enable-source-maps');
      expect(env.NODE_OPTIONS).toContain(`--max-old-space-size=${TSC_HEAP_MB}`);
    } finally {
      if (prev === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = prev;
    }
  });

  it('passes `extra` through, so the pc-heavy coalescing vars still reach the child', () => {
    // The pc-heavy spawn branch relies on this: swapping the inline env object for
    // tscChildEnv() must not drop PC_HEAVY_COALESCE_SEC / PC_HEAVY_FRESH_AFTER.
    const env = tscChildEnv({ PC_HEAVY_COALESCE_SEC: '420', PC_HEAVY_FRESH_AFTER: '17' });
    expect(env.PC_HEAVY_COALESCE_SEC).toBe('420');
    expect(env.PC_HEAVY_FRESH_AFTER).toBe('17');
    expect(env.NODE_OPTIONS).toContain('--max-old-space-size=');
  });

  it('retries exact exclusive-materializer preemptions without hiding caller overrides', () => {
    const prev = process.env.PC_HEAVY_RETRY_PREEMPTIONS;
    delete process.env.PC_HEAVY_RETRY_PREEMPTIONS;
    try {
      expect(tscChildEnv().PC_HEAVY_RETRY_PREEMPTIONS).toBe('3');
      expect(tscChildEnv({ PC_HEAVY_RETRY_PREEMPTIONS: '0' }).PC_HEAVY_RETRY_PREEMPTIONS).toBe('0');
    } finally {
      if (prev === undefined) delete process.env.PC_HEAVY_RETRY_PREEMPTIONS;
      else process.env.PC_HEAVY_RETRY_PREEMPTIONS = prev;
    }
  });
});

// EI-847: the operator-vite counterpart of the gate above, built on the same shared
// scripts/lib/tsc-baseline-gate.mjs policy (see lint-tsc-operator-vite.mjs).
describe('operator-vite TSC_COMMAND (EI-847)', () => {
  it('targets the operator-vite tsconfig and carries the same fresh-measurement guard', () => {
    expect(OPERATOR_VITE_TSC_COMMAND).toContain('apps/operator-vite/tsconfig.json');
    expect(OPERATOR_VITE_TSC_COMMAND).toContain('--incremental false');
    expect(OPERATOR_VITE_TSC_COMMAND).toContain('--noEmit');
  });
});

// REMOVED (WI-6396): `scripts/lint-tsc.d.mts stays in sync with scripts/lint-tsc.mjs`.
//
// That test existed only because the declaration was HAND-MAINTAINED. It parsed the
// `.d.mts` for `export function|const` names and asserted every runtime export appeared
// there — a hand-rolled drift check policing a hand-synced projection. It was written
// after that projection had already drifted twice (`parseExplicitFiles`, then
// `formatAttributionHeadline`), each drift costing this file a permanent baselined
// TS2305 that everyone learned to look past.
//
// `scripts/lint-tsc.d.mts` is now GENERATED from source via `tsconfig.declarations.json`,
// so an export cannot exist at runtime and be missing from the declaration: the
// declaration is derived from the same file. Two guards replace this one, and both live
// in `generated-declarations.test.ts`:
//   - `gen:declarations:check` fails if any committed declaration is stale, and
//   - semantic assertions fail if a type silently widens to `any`, which a byte-compare
//     provably cannot catch.
//
// Deleting it was the point, not a side effect — the item's own check was that if this
// block could NOT be removed, the conversion had not actually been done.
//
// Worth keeping in view: `lint-tsc.mjs` is a thin re-export shim over
// `scripts/lib/tsc-baseline-gate.mjs`, so the hand-written declaration had been
// hand-syncing a DIFFERENT module's contract across a file boundary — which is almost
// certainly why it drifted both times. The generated declaration re-exports from that
// module instead, so the types now follow the import.

describe('formatAttributionHeadline — the gate may only claim authorship it can actually prove', () => {
  // WHY THIS IS PINNED. `--mine` derives "your" files from `git status`, and this repo has ONE
  // working tree shared by the whole fleet with every agent's edits unstaged until the next
  // git-sync tick. So under --mine the set is "dirty right now" — yours AND every peer's — and
  // a headline saying "YOU changed" over it is simply false. It was filed four separate times
  // (EI-18731016038876755, which added --files, plus three duplicates) because each agent
  // independently burned time chasing a peer's error in a file they had never opened. The
  // costlier direction is the inverse: your OWN regression arrives amid peer noise under the
  // same "YOU changed" label, so the natural read is "fleet drift, not mine" and it ships.
  it('does NOT claim authorship for a git-inferred (--mine) set, and says how to scope it', () => {
    const headline = formatAttributionHeadline({ count: 1, explicit: false });
    expect(headline).not.toMatch(/YOU changed/i);
    expect(headline).toContain('DIRTY IN THE WORKING TREE');
    expect(headline).toContain('--files=');
  });

  it('DOES claim authorship for an explicitly-named (--files) set — there it is a fact', () => {
    const headline = formatAttributionHeadline({ count: 2, explicit: true });
    expect(headline).toContain('YOU NAMED');
    expect(headline).toContain('2 file(s)');
  });

  // WHY THIS IS PINNED (EI-23783377300333258). Under `--files` the REPORTED set is deliberately
  // wider than the argument: cause-aware widening also gates a file reached from a type one of
  // the named files exports. Measured, two paths named produced NINE reported — all nine under
  // `file(s) YOU NAMED`. That is a false claim about the caller's ARGUMENTS, and its natural
  // reading ("I passed the wrong --files") sends the reader to re-type the flag exactly when the
  // gate is handing them a correct finding. Re-scoping can never clear a type-reached file, so
  // the misdirection has no self-correcting end.
  it('does NOT attribute the whole reported set to the caller when widening reached past --files', () => {
    const headline = formatAttributionHeadline({ count: 9, explicit: true, typeAttributedCount: 7 });
    // The exact falsehood: the TOTAL presented as the named count. "YOU NAMED" itself survives —
    // 2 of them genuinely were named — so asserting on the bare phrase would pin the wrong thing.
    expect(headline).not.toMatch(/9 file\(s\) YOU NAMED/);
    expect(headline).toContain('9 file(s)');
    expect(headline).toContain('2 YOU NAMED');
    expect(headline).toContain('7');
    // Must not send the reader back to their arguments: the argument was correct.
    expect(headline).toMatch(/--files set was not wrong/);
  });

  it('says plainly when NONE of the reported files were named', () => {
    const headline = formatAttributionHeadline({ count: 3, explicit: true, typeAttributedCount: 3 });
    expect(headline).toContain('NONE of them are files you named');
    expect(headline).not.toMatch(/3 file\(s\) YOU NAMED/);
  });

  // The split must be additive-only: every pre-existing caller omits the new count, and the
  // fleet reads this verdict as authoritative (see tsc-red-observations.mjs), so the un-split
  // wording has to come back byte-identical rather than merely similar.
  it('reproduces the original wording verbatim when no file was reached past the named set', () => {
    expect(formatAttributionHeadline({ count: 2, explicit: true, typeAttributedCount: 0 })).toBe(
      formatAttributionHeadline({ count: 2, explicit: true }),
    );
    expect(formatAttributionHeadline({ count: 2, explicit: true })).toContain(
      '2 file(s) YOU NAMED added type errors above their baseline:',
    );
  });

  // A wrong-implementation control: the count arrives from a sibling array, so an inconsistent
  // pair must degrade to a clamped, still-true headline rather than emit a negative subset.
  it('clamps an out-of-range subset instead of printing a negative count', () => {
    const headline = formatAttributionHeadline({ count: 2, explicit: true, typeAttributedCount: 99 });
    expect(headline).not.toMatch(/-\d/);
    expect(headline).toContain('NONE of them are files you named');
  });

  it('splits the --mine headline too, without losing its peer-drift caveat or its remedy', () => {
    const headline = formatAttributionHeadline({ count: 5, explicit: false, typeAttributedCount: 2 });
    expect(headline).not.toMatch(/5 file\(s\) DIRTY IN THE WORKING TREE/);
    expect(headline).toContain('3 DIRTY IN THE WORKING');
    expect(headline).toContain("yours AND every peer's");
    expect(headline).toContain('--files=');
  });
});

describe('formatNewFileGuidance — never prescribe the flag the caller already passed', () => {
  // WHY THIS IS PINNED (EI-18802204276510164). The `fail-new-file` verdict itself is correct and
  // deliberate (EI-18766822535373909) and must not move: a file the baseline has never seen has no
  // known-good state to drift from, so no scoping can exonerate it. What was wrong was only the
  // remedy line — it closed with "re-run with --files=<paths>" even when the caller HAD passed
  // --files (the run echoes `[--files]` in its own header two lines earlier). Prescribing the
  // action already taken reads as "I invoked it wrong", so the reader goes to the script to find
  // their mistake instead of to the actual next step. It lands specifically on the agents doing
  // the right thing — scoping precisely — at the moment they are deciding whether their change is
  // safe to leave in the tree.
  const joined = (explicit: boolean) => formatNewFileGuidance({ explicit }).join('\n');

  it('under --files: does NOT tell the caller to re-run with --files', () => {
    expect(joined(true)).not.toMatch(/re-run with --files/i);
  });

  it('under --files: names the real next step (fix it, or tell its author) instead', () => {
    const text = joined(true);
    expect(text).toMatch(/outside the .*--files.* set|set you named/i);
    expect(text).toMatch(/author/i);
  });

  it('under --mine: still offers --files= as the scoping remedy (it is genuinely next there)', () => {
    const text = joined(false);
    expect(text).toContain('--files=');
    // The git-sync rationale is the whole reason --mine cannot exonerate; it must survive.
    expect(text).toMatch(/git-sync/i);
  });

  // Non-vacuousness: the wording change must not soften the EI-18766822535373909 invariant in
  // EITHER mode. If a future edit ever lets one branch imply the new file can be scoped away,
  // this fails rather than silently greenwashing the verdict the guidance explains.
  it.each([true, false])(
    'explicit=%s: always states that a new file has no baseline to drift from',
    (explicit) => {
      expect(joined(explicit)).toMatch(/baseline has no known-good state|no baseline at all/i);
    },
  );
});

describe('formatStandingRedFooter — never ask for an owner the sweeper is already deciding about (WI-7153)', () => {
  // WHY THIS IS PINNED. This footer and `recordStandingReds()` run on the SAME population, a few
  // lines apart, and used to contradict each other: the footer closed with "the committed one(s)
  // above need an owner" while the recorder existed precisely BECAUSE filing on first sight is
  // wrong — these reds are dominated by self-healing (measured 2026-08-02: 4 of 5 gone in 15min),
  // so tsc-red-sweep waits DWELL_SEC before judging one ownerless.
  //
  // The prose won, because agents read prose and appendFileSync is silent. Two agents filed the
  // SAME 9 paths 75 seconds apart on 2026-08-02 (WI-7149 / WI-7150) at 1.9–7.1 minutes of observed
  // life — 6–24x under the dwell — manufacturing exactly the backlog noise the split was built to
  // prevent. A third of the same shape (EI-19374659820125824) was closed as a duplicate the same
  // day. If a future edit reintroduces a call to action here, this fails instead of quietly
  // re-arming the duplicate generator.
  const joined = (opts?: { dwellSec?: number }) => formatStandingRedFooter(opts).join('\n');

  it('does NOT tell the reader the reds need an owner', () => {
    expect(joined()).not.toMatch(/needs? an owner/i);
  });

  it('says the finding is already recorded, and says not to hand-file', () => {
    const text = joined();
    expect(text).toMatch(/already recorded/i);
    expect(text).toMatch(/do NOT hand-file/i);
  });

  it('names the sweeper that owns the decision, so the reader can go read it', () => {
    expect(joined()).toMatch(/tsc-red-sweep/);
  });

  // The dwell must be DERIVED, not written out: a hardcoded "45min" silently becomes a lie the
  // moment DWELL_SEC moves, and this footer is the only place most readers ever learn the policy.
  it('derives the dwell from the passed dwellSec rather than hardcoding it', () => {
    expect(joined({ dwellSec: 45 * 60 })).toContain('45min');
    expect(joined({ dwellSec: 90 * 60 })).toContain('90min');
    expect(joined({ dwellSec: 90 * 60 })).not.toContain('45min');
  });

  // Non-vacuousness. The remedy for over-filing is NOT "ignore these" — a committed red really
  // does red the fleet at the next bare run. If a future edit softens this into pure reassurance,
  // it would trade a duplicate-work-item problem for an ignored-standing-red problem, which is
  // strictly worse. The footer must keep telling an owner to act.
  it('still tells a reader who OWNS one of these to fix it', () => {
    expect(joined()).toMatch(/if one is yours.*fix it/i);
  });

  it('does not claim the run failed — a scoped run stays green on files it did not name', () => {
    expect(joined()).toMatch(/stays green/i);
  });
});

const SAMPLE = [
  "lib/foo.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.",
  "lib/foo.ts(22,1): error TS2339: Property 'x' does not exist on type 'Y'.",
  "lib/broken.ts(1,1): error TS1005: ';' expected.",
  'some banner line without an error',
  'error TS5042: Option project cannot be mixed with source files.',
].join('\n');

describe('parseTscErrors', () => {
  it('extracts file + code per diagnostic, tolerating unattributed lines', () => {
    const errors = parseTscErrors(SAMPLE);
    expect(errors).toHaveLength(4);
    expect(errors[0]).toEqual({ file: 'lib/foo.ts', code: 'TS2322' });
    expect(errors[2]).toEqual({ file: 'lib/broken.ts', code: 'TS1005' });
    expect(errors[3]).toEqual({ file: null, code: 'TS5042' });
  });

  it('returns [] for clean output', () => {
    expect(parseTscErrors('')).toEqual([]);
    expect(parseTscErrors('all good\n')).toEqual([]);
  });

  // EI-21523730940957057 — a duplicated compiler stream used to inflate per-file counts once per
  // copy, so the gate reported `status=regressed` for files whose DISTINCT error count equalled
  // their baseline. The pair below is the point: the first test proves duplicates collapse, the
  // second proves the key is the FULL identity, so the dedupe cannot over-collapse distinct errors.
  it('counts a verbatim-repeated diagnostic once, however many times it is emitted', () => {
    const line = "lib/foo.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.";
    expect(parseTscErrors([line, line, line].join('\n'))).toEqual([
      { file: 'lib/foo.ts', code: 'TS2322' },
    ]);
    // The regression this guards is the COUNT, so assert it the way the gate consumes it.
    expect(countByFile(parseTscErrors([line, line, line].join('\n')))).toEqual({ 'lib/foo.ts': 1 });
    expect(countByFile(parseTscErrors(line))).toEqual({ 'lib/foo.ts': 1 });
  });

  it('keeps diagnostics that differ in line, column, or code — dedupe is on the full identity', () => {
    const errors = parseTscErrors(
      [
        'lib/foo.ts(10,5): error TS2322: a',
        'lib/foo.ts(11,5): error TS2322: differs by line',
        'lib/foo.ts(10,6): error TS2322: differs by column',
        'lib/foo.ts(10,5): error TS2339: differs by code',
      ].join('\n'),
    );
    expect(errors).toHaveLength(4);
    expect(countByFile(errors)).toEqual({ 'lib/foo.ts': 4 });
  });

  it('does not dedupe unattributed diagnostics, which carry no position to identify them by', () => {
    const bare = 'error TS5042: Option project cannot be mixed with source files.';
    expect(parseTscErrors([bare, bare].join('\n'))).toEqual([
      { file: null, code: 'TS5042' },
      { file: null, code: 'TS5042' },
    ]);
  });
});

describe('nested worktree diagnostic paths (EI-21125819548056320)', () => {
  const canonicalRoot = '/repo';
  const worktreeRoot = '/repo/.papercusp/worktrees/candidate';
  const file = 'packages/operator-core/lib/tsc-baseline-gate.ts';

  it('maps both worktree-relative spellings to one repo-relative baseline key', () => {
    expect(normalizeDiagnosticPath(file, { root: worktreeRoot, canonicalRoot })).toBe(file);
    expect(normalizeDiagnosticPath(`../../../${file}`, { root: worktreeRoot, canonicalRoot })).toBe(file);
  });

  it('collapses mixed physical-root diagnostics before per-file counting', () => {
    const output = [
      `${file}(1,1): error TS2322: first`,
      `../../../${file}(2,1): error TS2339: second`,
    ].join('\n');
    const errors = normalizeTscErrorPaths(parseTscErrors(output), {
      root: worktreeRoot,
      canonicalRoot,
    });
    expect(countByFile(errors)).toEqual({ [file]: 2 });
  });

  it('uses the same canonical key when quoting nested-worktree diagnostics', () => {
    const output = [
      `${file}(1,1): error TS2322: first`,
      `../../../${file}(2,1): error TS2339: second`,
    ].join('\n');
    const quoted = diagnosticLinesForFiles(output, [file], {
      root: worktreeRoot,
      canonicalRoot,
    });
    expect(quoted.get(file)).toHaveLength(2);
  });
});

describe('syntaxBrokenFiles', () => {
  it('flags files with parser/scanner TS1xxx diagnostics', () => {
    expect(syntaxBrokenFiles(parseTscErrors(SAMPLE))).toEqual(['lib/broken.ts']);
  });

  it('does not classify TS1320 semantic await/type errors as syntax failures', () => {
    const errors = parseTscErrors(
      "lib/a.ts(597,60): error TS1320: Type of 'await' operand must either be a valid promise or must not contain a callable 'then' member.",
    );
    expect(syntaxBrokenFiles(errors)).toEqual([]);
  });

  it('does not confuse TS1xxx with longer codes (TS1xxxx)', () => {
    const errors = parseTscErrors('lib/a.ts(1,1): error TS18046: x is of type unknown.');
    expect(syntaxBrokenFiles(errors)).toEqual([]);
  });
});

describe('countByFile', () => {
  it('aggregates errors per file, bucketing unattributed under (unattributed)', () => {
    expect(countByFile(parseTscErrors(SAMPLE))).toEqual({
      'lib/foo.ts': 2,
      'lib/broken.ts': 1,
      '(unattributed)': 1,
    });
  });
});

// EI-18731016038876755: --mine's git-status-derived scoping attributes EVERY dirty file on the
// shared checkout to the caller, including a PEER's in-flight edit — there is no session-scoped
// signal in `git status` to tell the two apart. `--files=` sidesteps the ambiguity: the caller
// states exactly which files are theirs instead of the gate guessing from tree dirt.
describe('parseExplicitFiles (EI-18731016038876755)', () => {
  it('returns null when --files= is absent — falls through to existing --mine/bare behavior', () => {
    expect(parseExplicitFiles([])).toBeNull();
    expect(parseExplicitFiles(['--mine', '--update'])).toBeNull();
  });

  it('parses a comma-separated --files= list into a Set of trimmed paths', () => {
    const s = parseExplicitFiles(['--files=lib/a.ts,lib/b.ts']);
    expect(s).toEqual(new Set(['lib/a.ts', 'lib/b.ts']));
  });

  it('parses a separated --files list instead of silently widening to the whole project', () => {
    const s = parseExplicitFiles(['--files', 'lib/a.ts,lib/b.ts']);
    expect(s).toEqual(new Set(['lib/a.ts', 'lib/b.ts']));
  });

  it('retains every space-separated path supplied after one --files flag', () => {
    const s = parseExplicitFiles(['--files', 'lib/a.ts', 'lib/b.ts', '--update']);
    expect(s).toEqual(new Set(['lib/a.ts', 'lib/b.ts']));
  });

  it('tolerates stray whitespace around entries', () => {
    const s = parseExplicitFiles(['--files= lib/a.ts , lib/b.ts ']);
    expect(s).toEqual(new Set(['lib/a.ts', 'lib/b.ts']));
  });

  it('drops empty entries from a trailing/double comma without erroring', () => {
    const s = parseExplicitFiles(['--files=lib/a.ts,,lib/b.ts,']);
    expect(s).toEqual(new Set(['lib/a.ts', 'lib/b.ts']));
  });

  it('a single file still yields a one-element Set (not null)', () => {
    expect(parseExplicitFiles(['--files=lib/a.ts'])).toEqual(new Set(['lib/a.ts']));
  });

  it('finds --files= among other flags in any position', () => {
    expect(parseExplicitFiles(['--update', '--files=lib/a.ts', '--mine'])).toEqual(new Set(['lib/a.ts']));
  });

  it('loads a JSON response file through --files-from= for large explicit scopes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-tsc-files-from-'));
    const responseFile = join(dir, 'files.json');
    const files = ['packages/operator-core/lib/a.ts', 'packages/operator-core/lib/b.ts'];
    writeFileSync(responseFile, JSON.stringify(files));
    try {
      expect(parseExplicitFiles([`--files-from=${responseFile}`])).toEqual(new Set(files));
      expect(parseExplicitFiles(['--files-from', responseFile])).toEqual(new Set(files));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Integration with the existing decidePerFile policy: an explicit file list is just another
// `changedFiles` Set from decidePerFile's point of view — this is the shape runTscBaselineGate
// wires it through as, proving --files= gets the SAME peer-drift-vs-attributed semantics --mine
// already has, not a parallel/weaker code path.
describe('parseExplicitFiles feeding decidePerFile (EI-18731016038876755)', () => {
  const brokenFree: string[] = [];

  it('a regression in a file NOT in the explicit list reports as peer drift, not attributed', () => {
    const changedFiles = parseExplicitFiles(['--files=b.ts'])!;
    const r = decidePerFile({
      currentByFile: { 'a.ts': 3, 'b.ts': 1 },
      baselineByFile: { 'a.ts': 2, 'b.ts': 1 },
      brokenFiles: brokenFree,
      changedFiles,
    });
    expect(r.verdict).toBe('ok-peer-drift');
    expect(r.peerDrift!.map((x: { file: string }) => x.file)).toEqual(['a.ts']);
  });

  // EI-18766822535373909 — the live failure this pins: a brand-new file's REAL error was
  // reported under a leading ✓ as "peer drift — not your regression", because git-sync had
  // already auto-committed the file so it was no longer in `git status` and thus not in the
  // caller's changed set. A file the baseline has never seen can never be dismissed that way.
  it('a NEW file (absent from baseline) NOT in the changed set is NOT peer drift — it gates', () => {
    const r = decidePerFile({
      currentByFile: { 'a.ts': 2, 'brand-new.ts': 1 },
      baselineByFile: { 'a.ts': 2 },
      brokenFiles: brokenFree,
      // The caller's changed set does not contain the new file — exactly the live case.
      changedFiles: new Set(['b.ts']),
    });
    expect(r.verdict).toBe('fail-new-file');
    expect(r.newFiles!.map((x: { file: string }) => x.file)).toEqual(['brand-new.ts']);
    expect(r.peerDrift).toEqual([]);
  });

  // Non-vacuousness: the case above must fail for the NEW-FILE reason specifically, not because
  // any unchanged regression now gates. A file WITH a baseline still drifts benignly.
  it('a KNOWN file (in the baseline) not in the changed set is STILL benign peer drift', () => {
    const r = decidePerFile({
      currentByFile: { 'a.ts': 3, 'b.ts': 1 },
      baselineByFile: { 'a.ts': 2, 'b.ts': 1 },
      brokenFiles: brokenFree,
      changedFiles: new Set(['b.ts']),
    });
    expect(r.verdict).toBe('ok-peer-drift');
    expect(r.peerDrift!.map((x: { file: string }) => x.file)).toEqual(['a.ts']);
    expect(r.newFiles).toEqual([]);
  });

  it('a new file that IS in the changed set stays attributed (fail-attributed, not fail-new-file)', () => {
    const r = decidePerFile({
      currentByFile: { 'brand-new.ts': 1 },
      baselineByFile: {},
      brokenFiles: brokenFree,
      changedFiles: new Set(['brand-new.ts']),
    });
    expect(r.verdict).toBe('fail-attributed');
    expect(r.attributed!.map((x: { file: string }) => x.file)).toEqual(['brand-new.ts']);
  });

  // EI-19305736771912430 — the same input must gate or not depending ONLY on how the changed set
  // was OBTAINED, because that is what decides whether "absent from the set" is evidence at all.
  // `--mine` INFERS it from git status (absence proves nothing — git-sync commits your new file out
  // of the set within minutes, which is the whole EI-18766822535373909 hazard above). `--files`
  // DECLARES it: the caller enumerated their own files, so a new file outside that list is one they
  // asserted is not theirs. These three cases are deliberately adjacent so the distinction cannot be
  // "simplified" away by a future reader who sees only one of them.
  const newFileOutsideSet = {
    currentByFile: { 'a.ts': 2, 'peer-brand-new.ts': 1 },
    baselineByFile: { 'a.ts': 2 },
    brokenFiles: brokenFree,
    changedFiles: new Set(['b.ts']),
  };

  it('--files (DECLARED): a new file outside the named set does NOT set the exit code — but is still reported', () => {
    const r = decidePerFile({ ...newFileOutsideSet, attributionDeclared: true });
    expect(r.verdict).toBe('ok-peer-drift');
    // Reported, not swallowed: a committed one is a standing red that WILL red the fleet, and the
    // reporter prints it. Not gating is what stops a SCOPED run crying wolf; dropping it entirely
    // would just trade one failure for another.
    expect(r.newFiles!.map((x: { file: string }) => x.file)).toEqual(['peer-brand-new.ts']);
  });

  it('--mine (INFERRED): the SAME input still gates — EI-18766822535373909 is not weakened', () => {
    const r = decidePerFile({ ...newFileOutsideSet, attributionDeclared: false });
    expect(r.verdict).toBe('fail-new-file');
    expect(r.newFiles!.map((x: { file: string }) => x.file)).toEqual(['peer-brand-new.ts']);
  });

  // EI-19340930095511759 — `ok-peer-drift`'s report of an unscoped NEW file used to be missing
  // the LANDING-RACE caveat its `fail-new-file` sibling already had (WI-6767). This pins the exact
  // pipeline `runTscBaselineGate` now runs over `ok-peer-drift`'s `newFiles`: a "COMMITTED" file
  // that landed inside LANDING_RACE_WINDOW_SEC must still surface the "wait a moment, verify
  // before filing" caveat — a reader who trusted a bare "COMMITTED: a standing red" here is exactly
  // who ends up re-fixing a peer's already-in-flight (or just-landed) rename, the collision the
  // filed bug reported.
  it('ok-peer-drift: a NEW COMMITTED file landed inside the window still surfaces the landing-race caveat', () => {
    const r = decidePerFile({ ...newFileOutsideSet, attributionDeclared: true });
    expect(r.verdict).toBe('ok-peer-drift');
    const { standing } = partitionNewFilesByLiveEdit(r.newFiles!);
    expect(standing.map((x: { file: string }) => x.file)).toEqual(['peer-brand-new.ts']);
    const NOW = 1_800_000_000;
    const { recent } = partitionStandingByCommitRecency(
      standing,
      new Map([['peer-brand-new.ts', NOW - 60]]), // landed 60s ago — well inside the window
      NOW,
    );
    expect(recent.map((x: { file: string }) => x.file)).toEqual(['peer-brand-new.ts']);
    const caveat = formatLandingRaceCaveat({ recentCount: recent.length }).join('\n');
    expect(caveat).toMatch(/landing/i);
    expect(caveat).toMatch(/re-run/i);
  });

  it('ok-peer-drift: a NEW COMMITTED file settled long ago prints no landing-race caveat', () => {
    const r = decidePerFile({ ...newFileOutsideSet, attributionDeclared: true });
    const { standing } = partitionNewFilesByLiveEdit(r.newFiles!);
    const NOW = 1_800_000_000;
    const { recent } = partitionStandingByCommitRecency(
      standing,
      new Map([['peer-brand-new.ts', NOW - LANDING_RACE_WINDOW_SEC - 1]]),
      NOW,
    );
    expect(recent).toEqual([]);
    expect(formatLandingRaceCaveat({ recentCount: recent.length })).toEqual([]);
  });

  it('--files (DECLARED): a new file that IS in the named set still gates — scoping never excuses your own', () => {
    const r = decidePerFile({
      currentByFile: { 'brand-new.ts': 1 },
      baselineByFile: {},
      brokenFiles: brokenFree,
      changedFiles: new Set(['brand-new.ts']),
      attributionDeclared: true,
    });
    expect(r.verdict).toBe('fail-attributed');
    expect(r.attributed!.map((x: { file: string }) => x.file)).toEqual(['brand-new.ts']);
  });

  // '(unattributed)' is not a file and is genuinely un-actionable, so it must NOT be pulled into
  // the gating new-file bucket just because it has no baseline entry.
  it("'(unattributed)' errors with no baseline stay in peerDrift, never gating as a new file", () => {
    const r = decidePerFile({
      currentByFile: { '(unattributed)': 2 },
      baselineByFile: {},
      brokenFiles: brokenFree,
      changedFiles: new Set(['b.ts']),
    });
    expect(r.verdict).toBe('ok-peer-drift');
    expect(r.newFiles).toEqual([]);
    expect(r.peerDrift!.map((x: { file: string }) => x.file)).toEqual(['(unattributed)']);
  });

  it('a regression in a file IN the explicit list fails, attributed', () => {
    const changedFiles = parseExplicitFiles(['--files=a.ts'])!;
    const r = decidePerFile({
      currentByFile: { 'a.ts': 3, 'b.ts': 1 },
      baselineByFile: { 'a.ts': 2, 'b.ts': 1 },
      brokenFiles: brokenFree,
      changedFiles,
    });
    expect(r.verdict).toBe('fail-attributed');
    expect(r.attributed!.map((x: { file: string }) => x.file)).toEqual(['a.ts']);
  });
});

// EI-23768041578113385 — the type-attribution widening (EI-18756182128903253) is deliberately
// over-inclusive: a file OUTSIDE your --files set still gates when it references an exported type
// one of your changed files also exports. That is CORRECT — missing a stranded consumer is what
// freezes `main`. But on this shared checkout its false positive is expensive: a PEER's uncommitted
// hunks in that file are reported as YOUR regression with a clean-looking `status=regressed`, and
// the natural next move is to go edit a live peer's work. These pin the live-edit signal that makes
// that false positive legible WITHOUT weakening the verdict.
describe('type-attributed rows carry the live-edit signal (EI-23768041578113385)', () => {
  const scopedTypeAttributed = (dirtyFiles: Set<string> | null) =>
    decidePerFile({
      currentByFile: { 'mine.ts': 0, 'peer.ts': 2 },
      baselineByFile: { 'mine.ts': 0, 'peer.ts': 0 },
      brokenFiles: [],
      changedFiles: new Set(['mine.ts']),
      typeReferencedFiles: new Set(['peer.ts']),
      dirtyFiles,
    });

  it('annotates a type-attributed file that is uncommitted (the peer-hunks case)', () => {
    const r = scopedTypeAttributed(new Set(['peer.ts']));
    expect(r.verdict).toBe('fail-attributed');
    expect(r.typeAttributed!.map((x: { file: string }) => x.file)).toEqual(['peer.ts']);
    expect(r.typeAttributed![0].dirty).toBe(true);
    expect(
      partitionEntriesByLiveEdit(r.typeAttributed!).liveEdits.map((x: { file: string }) => x.file),
    ).toEqual(['peer.ts']);
  });

  // The point is a routing HINT, never a fail-open: a dirty type-attributed file STILL gates.
  it('does NOT weaken the verdict — an uncommitted type-attributed file still fails', () => {
    expect(scopedTypeAttributed(new Set(['peer.ts'])).verdict).toBe('fail-attributed');
  });

  // Non-vacuousness: with no dirty set the annotation must be ABSENT, not `false`, so an unreadable
  // git state can never be read as "clean, therefore definitely yours".
  it('leaves dirty UNDEFINED when the dirty set is unavailable — never an exoneration', () => {
    const r = scopedTypeAttributed(null);
    expect(r.typeAttributed![0].dirty).toBeUndefined();
    const split = partitionEntriesByLiveEdit(r.typeAttributed!);
    expect(split.liveEdits).toEqual([]);
    expect(split.standing.map((x: { file: string }) => x.file)).toEqual(['peer.ts']);
  });

  // A file the caller NAMED is expected to be dirty (they just edited it). Annotating it would be
  // noise that trains the reader to ignore the marker on the rows where it carries information.
  it('does not annotate a file the caller named, even when that file is dirty', () => {
    const r = decidePerFile({
      currentByFile: { 'mine.ts': 2 },
      baselineByFile: { 'mine.ts': 0 },
      brokenFiles: [],
      changedFiles: new Set(['mine.ts']),
      typeReferencedFiles: new Set<string>(),
      dirtyFiles: new Set(['mine.ts']),
    });
    expect(r.verdict).toBe('fail-attributed');
    expect(r.attributed!.map((x: { file: string }) => x.file)).toEqual(['mine.ts']);
    expect(r.attributed![0].dirty).toBeUndefined();
  });

  // The new-file caller delegates to the generic primitive, so the two can never drift on the rule
  // that matters: `dirty !== true` — INCLUDING undefined — routes to `standing`.
  it('partitionNewFilesByLiveEdit delegates to partitionEntriesByLiveEdit', () => {
    const entries = [
      { file: 'a.ts', baseline: 0, current: 1, delta: 1, dirty: true },
      { file: 'b.ts', baseline: 0, current: 1, delta: 1, dirty: false },
      { file: 'c.ts', baseline: 0, current: 1, delta: 1 },
    ];
    expect(partitionNewFilesByLiveEdit(entries)).toEqual(partitionEntriesByLiveEdit(entries));
    expect(partitionEntriesByLiveEdit(entries).liveEdits.map((x: { file: string }) => x.file)).toEqual([
      'a.ts',
    ]);
    expect(partitionEntriesByLiveEdit(entries).standing.map((x: { file: string }) => x.file)).toEqual([
      'b.ts',
      'c.ts',
    ]);
  });
});

// P-010 / WI-4535: the per-file gate. The old gate compared ONE integer total against a single pin
// (224) — it could not attribute a regression and flapped ±N under concurrent edits. These pin the
// per-file replacement: a file above ITS baseline is a named regression; a flap in file A never
// reds an agent editing file B; --mine scopes the failure to the caller's changed files.
describe('decidePerFile — per-file attribution + --update-only ratchet + TS1xxx hard-fail', () => {
  const brokenFree: string[] = [];

  it('files with TS1xxx diagnostics hard-fail regardless of counts (unscoped / bare run)', () => {
    const r = decidePerFile({
      currentByFile: { 'a.ts': 1 },
      baselineByFile: { 'a.ts': 500 },
      brokenFiles: ['lib/broken.ts'],
    });
    expect(r.verdict).toBe('fail-syntax');
    expect(r.brokenFiles).toEqual(['lib/broken.ts']);
  });

  // EI-19321179234197157 — the live failure this pins: `--files=b.ts` hard-failed on a TS1xxx
  // TS1xxx diagnostic in `lib/peer-broken.ts`, a file the caller never named and — on this shared
  // single-worktree box — was simply a peer's in-flight edit. The TS1xxx hard-fail must be scoped
  // the same way a type-error regression already is: unattributed under `--mine`/`--files`, still
  // reported (never silently dropped), never gating.
  it('--files: a TS1xxx diagnostic OUTSIDE the named set does NOT gate — reported as unattributedBrokenFiles', () => {
    const r = decidePerFile({
      currentByFile: { 'b.ts': 0 },
      baselineByFile: { 'b.ts': 0 },
      brokenFiles: ['lib/peer-broken.ts'],
      changedFiles: new Set(['b.ts']),
    });
    expect(r.verdict).not.toBe('fail-syntax');
    expect(r.unattributedBrokenFiles).toEqual(['lib/peer-broken.ts']);
  });

  it('--files: a TS1xxx diagnostic INSIDE the named set still hard-fails, unconditionally', () => {
    const r = decidePerFile({
      currentByFile: { 'b.ts': 0 },
      baselineByFile: { 'b.ts': 500 },
      brokenFiles: ['b.ts', 'lib/peer-broken.ts'],
      changedFiles: new Set(['b.ts']),
    });
    expect(r.verdict).toBe('fail-syntax');
    expect(r.brokenFiles).toEqual(['b.ts']);
    expect(r.unattributedBrokenFiles).toEqual(['lib/peer-broken.ts']);
  });

  it('--mine (inferred changedFiles) scopes the TS1xxx hard-fail identically to --files', () => {
    const r = decidePerFile({
      currentByFile: { 'b.ts': 0 },
      baselineByFile: { 'b.ts': 0 },
      brokenFiles: ['lib/peer-broken.ts'],
      changedFiles: new Set(['b.ts']),
    });
    expect(r.verdict).not.toBe('fail-syntax');
  });

  // EI-19321397364088260 — the residual gap left after EI-19321179234197157 scoped the exit
  // code: the report itself still told EVERY unattributed broken file "a peer is likely
  // mid-edit", even one that was actually committed. Both bug reports asked for the same
  // committed-vs-uncommitted split `newFiles` already gets via partitionNewFilesByLiveEdit.
  it('splits unattributed broken files into a peer live edit vs a committed standing red', () => {
    const { liveEdits, standing } = partitionBrokenFilesByLiveEdit(
      ['lib/peer-live.ts', 'lib/peer-standing.ts'],
      new Set(['lib/peer-live.ts']),
    );
    expect(liveEdits).toEqual(['lib/peer-live.ts']);
    expect(standing).toEqual(['lib/peer-standing.ts']);
  });

  it('with dirtyFiles unavailable (--mine, or an unreadable git state) treats every entry as standing', () => {
    // Under --mine, changedFiles IS the dirty set, so anything reaching this function (outside
    // changedFiles) is by construction already committed — and an unreadable git state must
    // never manufacture an exoneration either. Same rule partitionNewFilesByLiveEdit applies.
    const { liveEdits, standing } = partitionBrokenFilesByLiveEdit(['lib/peer-broken.ts'], null);
    expect(liveEdits).toEqual([]);
    expect(standing).toEqual(['lib/peer-broken.ts']);
  });

  it('with an empty dirtyFiles set, still treats every entry as standing', () => {
    const { liveEdits, standing } = partitionBrokenFilesByLiveEdit(['lib/peer-broken.ts'], new Set());
    expect(liveEdits).toEqual([]);
    expect(standing).toEqual(['lib/peer-broken.ts']);
  });

  it('every file at its baseline is ok', () => {
    const r = decidePerFile({ currentByFile: { 'a.ts': 2, 'b.ts': 1 }, baselineByFile: { 'a.ts': 2, 'b.ts': 1 }, brokenFiles: brokenFree });
    expect(r.verdict).toBe('ok');
    expect(r.regressions).toEqual([]);
  });

  it('a file ABOVE its baseline is an attributed regression (fail-regressed, NAMED with old→new)', () => {
    const r = decidePerFile({ currentByFile: { 'a.ts': 4, 'b.ts': 1 }, baselineByFile: { 'a.ts': 2, 'b.ts': 1 }, brokenFiles: brokenFree });
    expect(r.verdict).toBe('fail-regressed');
    expect(r.regressions).toEqual([{ file: 'a.ts', baseline: 2, current: 4, delta: 2 }]);
  });

  it('a bare regression carries the shared-tree dirty annotation without changing the failing verdict', () => {
    const r = decidePerFile({
      currentByFile: { 'peer.ts': 2 },
      baselineByFile: { 'peer.ts': 0 },
      brokenFiles: brokenFree,
      dirtyFiles: new Set(['peer.ts']),
    });
    expect(r.verdict).toBe('fail-regressed');
    expect(r.regressions).toEqual([{ file: 'peer.ts', baseline: 0, current: 2, delta: 2, dirty: true }]);
  });

  it('a NEW file with errors (absent from baseline ⇒ implicit 0) is a regression', () => {
    const r = decidePerFile({ currentByFile: { 'a.ts': 2, 'new.ts': 1 }, baselineByFile: { 'a.ts': 2 }, brokenFiles: brokenFree });
    expect(r.verdict).toBe('fail-regressed');
    expect(r.regressions.map((x: { file: string }) => x.file)).toEqual(['new.ts']);
  });

  it('does NOT red an agent editing file B when only file A flapped up (attribution isolates the cause)', () => {
    // file A regressed +1, but the agent only touched b.ts → their change is clean under --mine.
    const r = decidePerFile({
      currentByFile: { 'a.ts': 3, 'b.ts': 1 },
      baselineByFile: { 'a.ts': 2, 'b.ts': 1 },
      brokenFiles: brokenFree,
      changedFiles: new Set(['b.ts']),
    });
    expect(r.verdict).toBe('ok-peer-drift');
    expect(r.peerDrift!.map((x: { file: string }) => x.file)).toEqual(['a.ts']);
    expect(r.attributed).toEqual([]);
  });

  it('--mine FAILS when the regression IS in a file the caller changed', () => {
    const r = decidePerFile({
      currentByFile: { 'a.ts': 3, 'b.ts': 1 },
      baselineByFile: { 'a.ts': 2, 'b.ts': 1 },
      brokenFiles: brokenFree,
      changedFiles: new Set(['a.ts']),
    });
    expect(r.verdict).toBe('fail-attributed');
    expect(r.attributed!.map((x: { file: string }) => x.file)).toEqual(['a.ts']);
  });

  it('a bare run (no --mine) gates ANY regression — CI stays strict', () => {
    const r = decidePerFile({
      currentByFile: { 'a.ts': 3 },
      baselineByFile: { 'a.ts': 2 },
      brokenFiles: brokenFree,
      changedFiles: null,
    });
    expect(r.verdict).toBe('fail-regressed');
  });

  it('below baseline on a BARE run is check-only (ok-below) — no ratchet, no baseline rewrite', () => {
    const r = decidePerFile({ currentByFile: { 'a.ts': 1 }, baselineByFile: { 'a.ts': 3 }, brokenFiles: brokenFree });
    expect(r.verdict).toBe('ok-below');
    expect(r.improvements).toEqual([{ file: 'a.ts', baseline: 3, current: 1, delta: -2 }]);
    expect(r.newBaselineByFile).toBeUndefined();
  });

  it('below baseline WITH --update ratchets improved files down (newBaselineByFile = current)', () => {
    const r = decidePerFile({ currentByFile: { 'a.ts': 1, 'b.ts': 2 }, baselineByFile: { 'a.ts': 3, 'b.ts': 2 }, brokenFiles: brokenFree, updateFlag: true });
    expect(r.verdict).toBe('ok-ratchet');
    expect(r.newBaselineByFile).toEqual({ 'a.ts': 1, 'b.ts': 2 });
  });

  it('regressions win over improvements — --update can never RAISE a file (ratchet-only-down)', () => {
    const r = decidePerFile({
      currentByFile: { 'a.ts': 5, 'b.ts': 1 }, // a regressed, b improved
      baselineByFile: { 'a.ts': 2, 'b.ts': 3 },
      brokenFiles: brokenFree,
      updateFlag: true,
    });
    expect(r.verdict).toBe('fail-regressed');
    expect(r.newBaselineByFile).toBeUndefined();
  });
});

// EI-19444246913245434 — `--files=X --update` wrote NOTHING while reporting
// `scope=update exit=0 status=clean`, so the caller believed the debt was locked in.
//
// The root cause is NOT "the --files branch returns before the ratchet branch" (how it was
// first filed, from the reporter's shape). It is one level up, in `decidePerFile`: the
// verdict is a single scalar, and the `regressions.length > 0` branch returns before
// improvements are ever considered. So ANY regression anywhere in the project swallows the
// caller's ratchet — INCLUDING drift the gate has, in that same branch, just classified as
// explicitly NOT the caller's problem (`ok-peer-drift`, exit 0, a leading ✓). On this shared
// tree peer drift is near-permanent, so the scoped ratchet had no working form at all.
//
// The fix keeps every existing verdict and its reporting untouched and restores only the
// dropped WRITE, as a payload (`ratchetFiles`) rather than a competing verdict — a ratchet is
// an EFFECT, and modelling it as a mutually-exclusive verdict is what let a classification
// swallow it.
describe('scoped --update composes with the caller’s own file set (EI-19444246913245434)', () => {
  const brokenFree: string[] = [];
  const own = new Set(['mine.ts']);

  it('THE LIVE BUG: ratchets the caller’s improved file even though a PEER file regressed', () => {
    const r = decidePerFile({
      currentByFile: { 'mine.ts': 1, 'peer.ts': 5 }, // mine 3→1 (improved), peer 2→5 (regressed)
      baselineByFile: { 'mine.ts': 3, 'peer.ts': 2 },
      brokenFiles: brokenFree,
      updateFlag: true,
      changedFiles: own,
      attributionDeclared: true, // --files
    });
    // The peer-drift REPORTING is deliberately unchanged — only the dropped write is restored.
    expect(r.verdict).toBe('ok-peer-drift');
    expect(r.ratchetFiles).toEqual([{ file: 'mine.ts', baseline: 3, current: 1, delta: -2 }]);
  });

  it('the scoped ratchet carries ONLY the caller’s files — never a peer’s improvement', () => {
    // peer.ts ALSO improved (2→1), but it is uncommitted on this shared tree: baking it in
    // creates a false red the moment that peer reverts. This is the racy write the bug report
    // named as the reason bare `--update` is not a safe workaround.
    const r = decidePerFile({
      currentByFile: { 'mine.ts': 1, 'peer.ts': 1 },
      baselineByFile: { 'mine.ts': 3, 'peer.ts': 2 },
      brokenFiles: brokenFree,
      updateFlag: true,
      changedFiles: own,
      attributionDeclared: true,
    });
    expect(r.ratchetFiles?.map((x) => x.file)).toEqual(['mine.ts']);
  });

  it('WITHOUT --update a scoped run stays check-only — no ratchet payload', () => {
    const r = decidePerFile({
      currentByFile: { 'mine.ts': 1, 'peer.ts': 5 },
      baselineByFile: { 'mine.ts': 3, 'peer.ts': 2 },
      brokenFiles: brokenFree,
      updateFlag: false,
      changedFiles: own,
      attributionDeclared: true,
    });
    expect(r.ratchetFiles).toBeUndefined();
  });

  it('ratchet-only-down still holds: a regression in the caller’s OWN file fails, no payload', () => {
    const r = decidePerFile({
      currentByFile: { 'mine.ts': 9, 'other.ts': 1 },
      baselineByFile: { 'mine.ts': 3, 'other.ts': 3 },
      brokenFiles: brokenFree,
      updateFlag: true,
      changedFiles: own,
      attributionDeclared: true,
    });
    expect(r.verdict).toBe('fail-attributed');
    expect(r.ratchetFiles).toBeUndefined();
  });

  it('a scoped run with no regressions anywhere still scopes the write (no full re-baseline)', () => {
    const r = decidePerFile({
      currentByFile: { 'mine.ts': 1, 'peer.ts': 1 }, // both improved; only mine.ts is the caller’s
      baselineByFile: { 'mine.ts': 3, 'peer.ts': 2 },
      brokenFiles: brokenFree,
      updateFlag: true,
      changedFiles: own,
      attributionDeclared: true,
    });
    expect(r.verdict).toBe('ok-ratchet');
    expect(r.ratchetFiles?.map((x) => x.file)).toEqual(['mine.ts']);
    // the full-replace map is what a BARE --update writes; a scoped run must not carry it
    expect(r.newBaselineByFile).toBeUndefined();
  });

  it('a BARE --update is unchanged — still a full re-baseline, no scoped payload', () => {
    const r = decidePerFile({
      currentByFile: { 'a.ts': 1, 'b.ts': 2 },
      baselineByFile: { 'a.ts': 3, 'b.ts': 2 },
      brokenFiles: brokenFree,
      updateFlag: true,
      changedFiles: null,
    });
    expect(r.verdict).toBe('ok-ratchet');
    expect(r.newBaselineByFile).toEqual({ 'a.ts': 1, 'b.ts': 2 });
    expect(r.ratchetFiles).toBeUndefined();
  });

  // The bug report asks for a regression test asserting the baseline VALUE changes, not the
  // exit code — the whole defect was an exit code that said `clean` over an unwritten file.
  it('the merge LOWERS the named file’s value and leaves every other entry byte-identical', () => {
    const before = { 'mine.ts': 3, 'peer.ts': 2, 'untouched.ts': 7 };
    const after = mergeRatchetIntoBaseline({
      baselineFiles: before,
      ratchetFiles: [{ file: 'mine.ts', baseline: 3, current: 1, delta: -2 }],
    });
    expect(after['mine.ts']).toBe(1); // the VALUE moved
    expect(after['peer.ts']).toBe(2);
    expect(after['untouched.ts']).toBe(7);
    expect(before['mine.ts']).toBe(3); // input not mutated
  });

  it('the marker names BOTH facts — a scoped update no longer reports as whole-project', () => {
    // The label was the more visible of the two disagreeing facts, which is what made the silent
    // no-op read as a successful ratchet.
    expect(lintTscScopeFromArgv(['--files=a.ts', '--update'])).toBe('update:files');
    expect(lintTscScopeFromArgv(['--mine', '--update'])).toBe('update:mine');
    expect(lintTscScopeFromArgv(['--update'])).toBe('update'); // bare is genuinely whole-project
    expect(lintTscScopeFromArgv(['--files=a.ts'])).toBe('files');
    expect(lintTscScopeFromArgv(['--mine'])).toBe('mine');
    expect(lintTscScopeFromArgv([])).toBe('all');
  });

  it('the merge ADDS a file the baseline has never recorded rather than dropping it', () => {
    const after = mergeRatchetIntoBaseline({
      baselineFiles: { 'peer.ts': 2 },
      ratchetFiles: [{ file: 'fresh.ts', baseline: 0, current: 0, delta: 0 }],
    });
    expect(after).toEqual({ 'peer.ts': 2, 'fresh.ts': 0 });
  });
});

// EI-18649014117371738: two gates over the SAME tree gave OPPOSITE verdicts on the same untouched
// files. `lint:tsc` passed (operator-core's baseline records e.g. memory/search.ts: 1 — known and
// tolerated) while `lint:tsc:operator-vite` failed, because that file was ABSENT from the vite
// baseline and absent⇒0 made it a phantom "0 → 1" regression. 12 operator-core files read as
// regressions to an agent who had opened none of them, which is the exact false signal the per-file
// gate exists to kill (EI-847) leaking back in at the cross-package seam. Absent means "this gate
// never recorded it", NOT "it was clean" — so a file OWNED by another package inherits that
// package's baseline instead of an implicit 0.
describe('effectiveBaselineByFile — cross-package files inherit their OWNER package baseline', () => {
  const FOREIGN = [
    {
      prefix: 'packages/operator-core/',
      files: { 'packages/operator-core/lib/agent-tools/memory/search.ts': 1 },
      label: 'operator-core',
    },
  ];

  it('the reported bug: a foreign file tolerated by its owner is NOT a regression here', () => {
    const currentByFile = { 'packages/operator-core/lib/agent-tools/memory/search.ts': 1 };
    const { effective, inherited } = effectiveBaselineByFile({
      baselineByFile: {}, // absent from THIS gate's baseline — the whole bug
      currentByFile,
      foreignBaselines: FOREIGN,
    });
    expect(effective['packages/operator-core/lib/agent-tools/memory/search.ts']).toBe(1);
    expect(inherited).toEqual([
      { file: 'packages/operator-core/lib/agent-tools/memory/search.ts', baseline: 1, from: 'operator-core' },
    ]);

    // ...and the gate now agrees with lint:tsc instead of contradicting it.
    const r = decidePerFile({ currentByFile, baselineByFile: effective, brokenFiles: [] });
    expect(r.verdict).toBe('ok');
    expect(r.regressions).toEqual([]);
  });

  it('WITHOUT inheritance the same input false-reds — pins that this test guards a real behaviour change', () => {
    const r = decidePerFile({
      currentByFile: { 'packages/operator-core/lib/agent-tools/memory/search.ts': 1 },
      baselineByFile: {},
      brokenFiles: [],
    });
    expect(r.verdict).toBe('fail-regressed');
  });

  it('a foreign file ABOVE its owner baseline is still a NAMED regression (no laundering)', () => {
    const currentByFile = { 'packages/operator-core/lib/agent-tools/memory/search.ts': 3 };
    const { effective } = effectiveBaselineByFile({ baselineByFile: {}, currentByFile, foreignBaselines: FOREIGN });
    const r = decidePerFile({ currentByFile, baselineByFile: effective, brokenFiles: [] });
    expect(r.verdict).toBe('fail-regressed');
    expect(r.regressions).toEqual([
      { file: 'packages/operator-core/lib/agent-tools/memory/search.ts', baseline: 1, current: 3, delta: 2 },
    ]);
  });

  it("this gate's OWN explicit baseline always wins — a foreign count can never loosen the ratchet", () => {
    const { effective, inherited } = effectiveBaselineByFile({
      baselineByFile: { 'packages/operator-core/lib/agent-tools/memory/search.ts': 0 },
      currentByFile: { 'packages/operator-core/lib/agent-tools/memory/search.ts': 1 },
      foreignBaselines: FOREIGN,
    });
    expect(effective['packages/operator-core/lib/agent-tools/memory/search.ts']).toBe(0);
    expect(inherited).toEqual([]);
  });

  it('a foreign file absent from BOTH baselines is still an implicit 0 — genuinely new errors gate', () => {
    const currentByFile = { 'packages/operator-core/lib/brand-new.ts': 2 };
    const { effective } = effectiveBaselineByFile({ baselineByFile: {}, currentByFile, foreignBaselines: FOREIGN });
    expect(effective['packages/operator-core/lib/brand-new.ts']).toBeUndefined();
    expect(decidePerFile({ currentByFile, baselineByFile: effective, brokenFiles: [] }).verdict).toBe('fail-regressed');
  });

  it('a file this gate OWNS is untouched by inheritance — new local files still gate at 0', () => {
    const currentByFile = { 'apps/operator-vite/src/New.tsx': 1 };
    const { effective, inherited } = effectiveBaselineByFile({ baselineByFile: {}, currentByFile, foreignBaselines: FOREIGN });
    expect(effective).toEqual({});
    expect(inherited).toEqual([]);
    expect(decidePerFile({ currentByFile, baselineByFile: effective, brokenFiles: [] }).verdict).toBe('fail-regressed');
  });

  it('never injects foreign files this gate did not MEASURE (no phantom improvements / inflated total)', () => {
    // memory/search.ts is in the owner baseline but not in this run's output: it must NOT appear,
    // or it would read as an "improvement" and inflate the reported baseline total.
    const { effective } = effectiveBaselineByFile({
      baselineByFile: {},
      currentByFile: { 'apps/operator-vite/src/App.tsx': 1 },
      foreignBaselines: FOREIGN,
    });
    expect(effective['packages/operator-core/lib/agent-tools/memory/search.ts']).toBeUndefined();
  });

  it('no foreign sources configured ⇒ byte-identical behaviour (operator-core gate unaffected)', () => {
    const baselineByFile = { 'a.ts': 2 };
    const { effective, inherited } = effectiveBaselineByFile({ baselineByFile, currentByFile: { 'a.ts': 2 } });
    expect(effective).toBe(baselineByFile); // same object — no copy, no change
    expect(inherited).toEqual([]);
  });
});

describe('operator-vite gate wiring (EI-18649014117371738)', () => {
  it('declares packages/operator-core as a foreign owner so the two gates cannot disagree', () => {
    const core = FOREIGN_BASELINES.find((s: { prefix: string }) => s.prefix === 'packages/operator-core/');
    expect(core, 'operator-vite measures operator-core files; it must inherit their owner baseline').toBeDefined();
    expect(core!.baselineFile).toMatch(/packages\/operator-core\/\.tsc-baseline\.json$/);
    // A stale path here would silently degrade to the old absent⇒0 false-red, so pin that it resolves.
    expect(existsSync(core!.baselineFile)).toBe(true);
  });
});

// EI-18756182128903253 — `--mine`/`--files` is structurally BLIND to the single most common
// gate-redding change shape: adding a REQUIRED field to a shared exported interface. By
// definition the new type errors that causes land in files the caller did NOT change (the
// fixtures/constructors that build that type) — so the caller's own `--mine` reads clean and
// the break first surfaces hours later at the fleet-wide green-checkpoint. Fix: widen attribution
// to any file that references a type/interface/class/enum one of the CHANGED files also exports.
describe('exportedTypeNames + filesReferencingTypeNames (EI-18756182128903253)', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('extracts exported interface/type/class/enum names, ignoring non-exported and local ones', () => {
    dir = mkdtempSync(join(tmpdir(), 'lint-tsc-type-names-'));
    writeFileSync(
      join(dir, 'shape.ts'),
      [
        'interface NotExported { x: number }',
        'export interface PipelinePosition { serving: string }',
        'export type ServingTruth = { ok: boolean };',
        'export class Widget {}',
        'export enum Mode { A, B }',
        'export default function foo() {}',
      ].join('\n'),
    );
    const names = exportedTypeNames(dir, ['shape.ts']);
    expect(names).toEqual(new Set(['PipelinePosition', 'ServingTruth', 'Widget', 'Mode']));
  });

  it('returns an empty set and never throws for an unreadable/missing file', () => {
    dir = mkdtempSync(join(tmpdir(), 'lint-tsc-type-names-'));
    expect(exportedTypeNames(dir, ['does-not-exist.ts'])).toEqual(new Set());
  });

  it('filesReferencingTypeNames finds a whole-word reference and ignores an unrelated file', () => {
    dir = mkdtempSync(join(tmpdir(), 'lint-tsc-type-names-'));
    writeFileSync(join(dir, 'fixture.ts'), 'const p: PipelinePosition = { serving: "x" };');
    writeFileSync(join(dir, 'unrelated.ts'), 'const q = 1 + 1;');
    const referencing = filesReferencingTypeNames(dir, ['fixture.ts', 'unrelated.ts'], new Set(['PipelinePosition']));
    expect(referencing).toEqual(new Set(['fixture.ts']));
  });

  it('filesReferencingTypeNames does not partial-match a substring of a longer identifier', () => {
    dir = mkdtempSync(join(tmpdir(), 'lint-tsc-type-names-'));
    writeFileSync(join(dir, 'decoy.ts'), 'const x: PipelinePositionExtended = {} as any;');
    const referencing = filesReferencingTypeNames(dir, ['decoy.ts'], new Set(['PipelinePosition']));
    expect(referencing).toEqual(new Set());
  });

  it('short-circuits to an empty set with zero type names — never opens a file needlessly', () => {
    dir = mkdtempSync(join(tmpdir(), 'lint-tsc-type-names-'));
    writeFileSync(join(dir, 'anything.ts'), 'export const x = 1;');
    expect(filesReferencingTypeNames(dir, ['anything.ts'], new Set())).toEqual(new Set());
  });
});

describe('resolved module attribution (EI-25720784739215773)', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('skips the symbol-less named import clause while retaining actual changed-type diagnostics (EI-26067051823790156)', () => {
    dir = mkdtempSync(join(tmpdir(), 'tsc-import-clause-'));
    writeFileSync(join(dir, 'shape.ts'), 'export interface Verdict { ok: boolean; reason: string }\n');
    writeFileSync(join(dir, 'user.ts'), "import type { Verdict } from './shape';\nconst v: Verdict = { ok: true };\n");
    const user = join(dir, 'user.ts');
    // A diagnostic from the earlier compile can now land on `type` in this
    // re-read snapshot. Ascending from that token used to query ImportClause,
    // whose undefined default-import symbol crashes TypeScript's checker.
    const run = (output: string) => diagnosticFilesDependingOnChangedTypes({
      root: dir, named: ['shape.ts'], candidates: ['user.ts'], output,
    });
    const clause = `${user}(1,8): error TS1484: a diagnostic at the import clause`;
    expect(() => run(clause)).not.toThrow();
    expect(run(clause)).toEqual(new Set());
    expect(run(`${clause}\n${user}(2,7): error TS2741: Property reason is missing`)).toEqual(new Set([user]));
  });

  it('gates real imported, aliased, namespace and inferred fixture regressions through a cyclic barrel', () => {
    dir = mkdtempSync(join(tmpdir(), 'tsc-module-provenance-'));
    const sources = {
      'shape.ts': 'export interface Verdict { ok: boolean; required: string }\nexport function take(v: Verdict) {}',
      'barrel.ts': "export * from './shape.js'; export * from './cycle.js';",
      'cycle.ts': "export * from './barrel.js';",
      'direct.ts': "import type { Verdict } from './shape.js'; const v: Verdict = { ok: true };",
      'alias.ts': "import type { Verdict as Result } from './barrel.js'; const v: Result = { ok: true };",
      'namespace.ts': "import * as shapes from './barrel.js'; const v: shapes.Verdict = { ok: true };",
      'inferred.ts': "import { take } from './barrel.js'; take({ ok: true });",
      'receiver.ts': "import type { Verdict } from './barrel.js'; const v: Verdict = { ok: true, required: 'yes' }; v.removed;",
      'comment.ts': '// Verdict Arm; import { Verdict } from "./shape.js";\nconst a: string = 1;',
      'string.ts': 'const text = `Verdict; import { Verdict } from "./shape.js"`; const a: string = 1;',
      'local.ts': 'interface Verdict { unrelated: string } const v: Verdict = {}; export {};',
      'other.ts': 'export interface Verdict { unrelated: string }',
      'other-fixture.ts': "import type { Verdict } from './other.js'; const v: Verdict = {};",
      'function-decoy.ts': "import { take } from './barrel.js'; interface Verdict { unrelated: string } const v: Verdict = {}; const s: string = 1;",
    };
    for (const [file, body] of Object.entries(sources)) writeFileSync(join(dir, file), body);
    const program = ts.createProgram(Object.keys(sources).map((file) => join(dir, file)), {
      noEmit: true, noLib: true, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });
    const errors = ts.getPreEmitDiagnostics(program).filter((d) => d.file && d.category === ts.DiagnosticCategory.Error);
    const counts: Record<string, number> = {};
    for (const d of errors) { const file = d.file!.fileName.slice(dir.length + 1); counts[file] = (counts[file] ?? 0) + 1; }
    const output = errors.map((d) => { const pos = d.file!.getLineAndCharacterOfPosition(d.start!);
      return `${d.file!.fileName}(${pos.line + 1},${pos.character + 1}): error TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
    }).join('\n');
    const dependents = diagnosticFilesDependingOnChangedTypes({ root: dir, named: ['shape.ts'], candidates: Object.keys(counts), output });
    const expected = ['direct.ts', 'alias.ts', 'namespace.ts', 'inferred.ts', 'receiver.ts'];
    expect([...dependents].sort()).toEqual(expected.map((file) => join(dir, file)).sort());
    const verdict = decidePerFile({ currentByFile: counts, baselineByFile: Object.fromEntries(Object.keys(counts).map((file) => [file, 0])),
      brokenFiles: [], changedFiles: new Set(['shape.ts']), typeReferencedFiles: new Set([...dependents].map((file) => file.slice(dir.length + 1))) });
    expect(verdict.verdict).toBe('fail-attributed');
    expect(verdict.attributed!.map((r) => r.file).sort()).toEqual(expected.sort());
    const scope = checkedSetFor({ root: dir, named: ['shape.ts'], programFiles: Object.keys(sources).map((f) => join(dir, f)),
      readText: (file) => readFileSync(file, 'utf8') });
    expect(scope.files.map((f) => f.slice(dir.length + 1)).sort()).toEqual(['shape.ts', 'barrel.ts', 'cycle.ts', 'function-decoy.ts', ...expected].sort());
  });

  it('resolves path aliases exactly instead of matching an unrelated module with the same suffix', () => {
    dir = mkdtempSync(join(tmpdir(), 'tsc-module-alias-'));
    mkdirSync(join(dir, 'other'), { recursive: true });
    writeFileSync(join(dir, 'shape.ts'), 'export interface Verdict { ok: boolean }');
    writeFileSync(join(dir, 'other/shape.ts'), 'export interface Verdict { unrelated: string }');
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@changed': ['./shape.ts'], '@other': ['./other/shape.ts'] } } }));
    writeFileSync(join(dir, 'real.ts'), "import type { Verdict as Result } from '@changed'; const v: Result = {};" );
    writeFileSync(join(dir, 'decoy.ts'), "import type { Verdict } from '@other'; const v: Verdict = {};" );
    expect(filesDependingOnChangedModules({ root: dir, named: ['shape.ts'], candidates: ['real.ts', 'decoy.ts'] }))
      .toEqual(new Set([join(dir, 'real.ts')]));
  });

  it('skips a diagnostic whose column no longer exists in the re-read file instead of crashing the gate (EI-25816656568127078)', () => {
    dir = mkdtempSync(join(tmpdir(), 'tsc-stale-column-'));
    writeFileSync(join(dir, 'shape.ts'), 'export interface Verdict { ok: boolean; reason: string }\n');
    writeFileSync(join(dir, 'user.ts'), "import type { Verdict } from './shape';\nconst v: Verdict = { ok: true };\nexport { v };\n");
    const user = join(dir, 'user.ts');
    const message = "error TS2741: Property 'reason' is missing in type '{ ok: true; }' but required in type 'Verdict'.";
    // tsc judged an earlier, longer snapshot of the shared tree. (2,400) is past the end of a middle
    // line and (4,50) is past the end of the final line: both name text that is gone, and each made
    // TypeScript's getPositionOfLineAndCharacter throw "Debug Failure. False expression.".
    const stale = [`${user}(2,400): ${message}`, `${user}(4,50): ${message}`].join('\n');
    const run = (output: string) =>
      diagnosticFilesDependingOnChangedTypes({ root: dir, named: ['shape.ts'], candidates: ['user.ts'], output });
    expect(() => run(stale)).not.toThrow();
    expect(run(stale)).toEqual(new Set());
    // Positive control: the same file still attributes from a location that exists (the `v` at 2:7),
    // so the skip is per-diagnostic and the empty set above is not the function going inert.
    expect(run(`${stale}\n${user}(2,7): ${message}`)).toEqual(new Set([user]));
  });
});

describe('a crashed typecheck gate reads error(70), never regressed (EI-25816656568127078)', () => {
  // Exit 1 is the gate's CONSIDERED failure, and the exit hook prints it as status=regressed. A
  // gate whose top-level crash handler also exits 1 reports an uncaught exception — e.g. the
  // TypeScript Debug Failure in diagnosticFilesDependingOnChangedTypes — as a type regression in
  // the caller's files. Every entrypoint that runs runTscBaselineGate must exit EX_SOFTWARE instead.
  const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../scripts');
  const entrypoints = readdirSync(scriptsDir)
    .filter((name) => /^lint-tsc.*\.mjs$/.test(name))
    .filter((name) => /\brunTscBaselineGate\(/.test(readFileSync(join(scriptsDir, name), 'utf8')));

  it('finds the gate entrypoints (the scan below is not vacuous)', () => {
    expect(entrypoints).toContain('lint-tsc.mjs');
    expect(entrypoints.length).toBeGreaterThanOrEqual(7);
  });

  it('every entrypoint crash handler exits TOOLCHAIN_FAILURE_EXIT_CODE, not 1', () => {
    const offenders = entrypoints.flatMap((name) => {
      const text = readFileSync(join(scriptsDir, name), 'utf8');
      const at = text.lastIndexOf('.catch((err)');
      if (at < 0) return [`${name}: no top-level .catch((err) => …) crash handler`];
      const handler = text.slice(at, text.indexOf('});', at));
      if (/process\.exit\(\s*1\s*\)/.test(handler)) return [`${name}: crash handler exits 1 (reads status=regressed)`];
      if (!handler.includes('process.exit(TOOLCHAIN_FAILURE_EXIT_CODE)')) return [`${name}: crash handler does not exit TOOLCHAIN_FAILURE_EXIT_CODE`];
      return [];
    });
    expect(offenders).toEqual([]);
  });

  it('the marker for that exit code is error(70), not regressed', () => {
    const marker = formatLintTscResultMarker({ label: 'operator-core', scope: 'files', code: TOOLCHAIN_FAILURE_EXIT_CODE });
    expect(marker).toContain(`status=error(${TOOLCHAIN_FAILURE_EXIT_CODE})`);
    expect(marker).not.toContain('status=regressed');
  });
});

describe('diagnosticFilesReferencingTypeNames — compiler messages close source-text attribution gaps (EI-21833727883305743)', () => {
  const DEPENDENT = 'packages/operator-core/lib/digest-fixture.test.ts';

  it('attributes a dependent when TS names the changed exported type but its source does not', () => {
    const output =
      `${DEPENDENT}(12,7): error TS2741: Property 'runId' is missing in type '{}' but required in type 'DailyDigestRunResult'.`;
    expect(
      diagnosticFilesReferencingTypeNames(
        output,
        [DEPENDENT],
        new Set(['DailyDigestRunResult']),
      ),
    ).toEqual(new Set([DEPENDENT]));
  });

  it('supports the other required-field assignability diagnostic codes', () => {
    const output = [
      `${DEPENDENT}(1,1): error TS2322: Type '{}' is not assignable to type 'DailyDigestRunResult'.`,
      `${DEPENDENT}(2,1): error TS2739: Type '{}' is missing the following properties from type 'DailyDigestRunResult': runId`,
    ].join('\n');
    expect(
      diagnosticFilesReferencingTypeNames(
        output,
        [DEPENDENT],
        new Set(['DailyDigestRunResult']),
      ),
    ).toEqual(new Set([DEPENDENT]));
  });

  it('does not attribute a different diagnostic code or a type name appearing only in the file path', () => {
    const output = [
      `${DEPENDENT}(3,1): error TS2339: Property 'runId' does not exist on type '{}'.`,
      `packages/operator-core/lib/DailyDigestRunResult-fixture.test.ts(4,1): error TS2741: Property 'runId' is missing.`,
    ].join('\n');
    expect(
      diagnosticFilesReferencingTypeNames(
        output,
        [DEPENDENT, 'packages/operator-core/lib/DailyDigestRunResult-fixture.test.ts'],
        new Set(['DailyDigestRunResult']),
      ),
    ).toEqual(new Set());
  });
});

// The RECURRENCE GUARD named in the filed bug: "a unit test over lint-tsc's scoping constructing
// the exact shape — file A adds a required field, unchanged file B breaks — asserting --mine does
// NOT report clean. That test fails today." This exercises decidePerFile directly with the
// typeReferencedFiles wiring runTscBaselineGate now computes, reproducing the measured live
// instance (PipelinePosition.serving made required in git-pipeline-position.ts,
// release-trace.test.ts's unchanged fixture broke).
describe('decidePerFile + typeReferencedFiles — the required-field-on-a-shared-interface shape', () => {
  const brokenFree: string[] = [];

  it('a regression OUTSIDE changedFiles gates when it references a type the changed file exports', () => {
    // git-pipeline-position.ts (changed, exports PipelinePosition) added a required field;
    // release-trace.test.ts (NOT in the diff) never updated its fixture and now fails to compile.
    const typeReferencedFiles = new Set(['packages/operator-core/lib/release-trace.test.ts']);
    const r = decidePerFile({
      currentByFile: {
        'packages/operator-core/lib/git-pipeline-position.ts': 0,
        'packages/operator-core/lib/release-trace.test.ts': 1,
      },
      baselineByFile: {
        'packages/operator-core/lib/git-pipeline-position.ts': 0,
        'packages/operator-core/lib/release-trace.test.ts': 0,
      },
      brokenFiles: brokenFree,
      changedFiles: new Set(['packages/operator-core/lib/git-pipeline-position.ts']),
      typeReferencedFiles,
    });
    // This is the assertion the filed bug says fails today (pre-fix, --mine reported ok-peer-drift
    // or ok here because release-trace.test.ts is not in changedFiles).
    expect(r.verdict).toBe('fail-attributed');
    expect(r.attributed!.map((x: { file: string }) => x.file)).toEqual([
      'packages/operator-core/lib/release-trace.test.ts',
    ]);
    expect(r.typeAttributed!.map((x: { file: string }) => x.file)).toEqual([
      'packages/operator-core/lib/release-trace.test.ts',
    ]);
  });

  it('WITHOUT typeReferencedFiles the identical input false-passes as ok-peer-drift — pins the exact live bug', () => {
    // Byte-identical to the first test's inputs, minus typeReferencedFiles: this is precisely
    // "--mine reads clean" from the filed report — release-trace.test.ts has a baseline entry (it
    // is a KNOWN file), so absent any type-reference signal it is dismissed as benign peer drift
    // rather than gated, even though it is the direct, real consequence of the changed file.
    const r = decidePerFile({
      currentByFile: {
        'packages/operator-core/lib/git-pipeline-position.ts': 0,
        'packages/operator-core/lib/release-trace.test.ts': 1,
      },
      baselineByFile: {
        'packages/operator-core/lib/git-pipeline-position.ts': 0,
        'packages/operator-core/lib/release-trace.test.ts': 0,
      },
      brokenFiles: brokenFree,
      changedFiles: new Set(['packages/operator-core/lib/git-pipeline-position.ts']),
      // no typeReferencedFiles — the pre-fix behaviour
    });
    expect(r.verdict).toBe('ok-peer-drift');
    expect(r.peerDrift!.map((x: { file: string }) => x.file)).toEqual([
      'packages/operator-core/lib/release-trace.test.ts',
    ]);
  });

  it('a file NOT referencing any changed-file type stays peer drift even with typeReferencedFiles active for others', () => {
    const r = decidePerFile({
      currentByFile: { 'a.ts': 0, 'unrelated.ts': 1, 'referencing.ts': 1 },
      baselineByFile: { 'a.ts': 0, 'unrelated.ts': 0, 'referencing.ts': 0 },
      brokenFiles: brokenFree,
      changedFiles: new Set(['a.ts']),
      typeReferencedFiles: new Set(['referencing.ts']),
    });
    expect(r.verdict).toBe('fail-attributed');
    expect(r.attributed!.map((x: { file: string }) => x.file)).toEqual(['referencing.ts']);
    // unrelated.ts has its own baseline entry (a KNOWN file), so it is benign peer drift, not
    // attributed — it is neither changed nor type-referenced.
    expect(r.peerDrift!.map((x: { file: string }) => x.file)).toEqual(['unrelated.ts']);
  });

  it('a file directly in changedFiles is attributed but NOT counted in typeAttributed (no double-widening)', () => {
    const r = decidePerFile({
      currentByFile: { 'a.ts': 1 },
      baselineByFile: { 'a.ts': 0 },
      brokenFiles: brokenFree,
      changedFiles: new Set(['a.ts']),
      typeReferencedFiles: new Set(['a.ts']), // even if it were (redundantly) also type-referenced
    });
    expect(r.verdict).toBe('fail-attributed');
    expect(r.attributed!.map((x: { file: string }) => x.file)).toEqual(['a.ts']);
    expect(r.typeAttributed).toEqual([]); // changedFiles wins; not double-counted as type-attributed
  });
});

describe('new files: a peer mid-edit is not the caller’s regression (EI-19278299775574199)', () => {
  // WHY THIS EXISTS. Under `--files` the caller ENUMERATED their own files, so a new-to-the-baseline
  // file outside that set is by definition not one they named. Every such file used to be printed
  // the same way — "If one is yours, fix it" — whether it was a peer's uncommitted, actively-changing
  // buffer or a committed standing red. Those need OPPOSITE actions, and the gate conflated them:
  //
  //   - DIRTY (uncommitted right now): someone else has it open. It is transient, it has not reached
  //     origin, and it is NOT yet a fleet-gate red. Editing it stomps a live peer — the filed report
  //     nearly hand-edited a 3,188-line file another agent was writing to at that moment.
  //   - CLEAN (committed): a standing red that WILL red the fleet at the next bare run. Loud is right.
  //
  // The VERDICT deliberately does not move (EI-18766822535373909 — a file with no baseline has no
  // known-good state to drift from, and git-sync commits the tree every few minutes, so *absence*
  // from the changed set can never exonerate). Only the ATTRIBUTION and the remedy change. Note the
  // distinction is reachable only under `--files`: under `--mine` the changed set IS the dirty set,
  // so a dirty file is already `attributed` and can never land in `newFiles`.
  const brokenFree: string[] = [];

  it('annotates a new file as dirty when it is uncommitted in the shared tree', () => {
    const r = decidePerFile({
      currentByFile: { 'mine.ts': 0, 'peer-new.ts': 5 },
      baselineByFile: { 'mine.ts': 0 },
      brokenFiles: brokenFree,
      changedFiles: new Set(['mine.ts']),
      dirtyFiles: new Set(['peer-new.ts']),
    });
    expect(r.verdict).toBe('fail-new-file');
    expect(r.newFiles!.map((x: { file: string; dirty?: boolean }) => [x.file, x.dirty])).toEqual([
      ['peer-new.ts', true],
    ]);
  });

  it('annotates a COMMITTED new file as not-dirty (a standing red, not a live edit)', () => {
    const r = decidePerFile({
      currentByFile: { 'mine.ts': 0, 'landed-new.ts': 2 },
      baselineByFile: { 'mine.ts': 0 },
      brokenFiles: brokenFree,
      changedFiles: new Set(['mine.ts']),
      dirtyFiles: new Set(), // nothing uncommitted — it has landed
    });
    expect(r.newFiles!.map((x: { file: string; dirty?: boolean }) => [x.file, x.dirty])).toEqual([
      ['landed-new.ts', false],
    ]);
  });

  it('does not assert a clean diagnostic site is committed while another path is uncommitted', () => {
    const text = formatStandingRedRow(
      { file: 'fixture.test.ts', baseline: 0, current: 1, delta: 1 },
      { dirtyPathCount: 1 },
    );
    expect(text).toMatch(/clean error site/i);
    expect(text).toMatch(/causal origin unresolved/i);
    expect(text).toMatch(/uncommitted/i);
    expect(text).not.toContain('← COMMITTED:');
    expect(text).not.toMatch(/WILL red the fleet/i);
  });

  it('retains the strong standing-red warning when the tree has no uncommitted alternative cause', () => {
    const text = formatStandingRedRow(
      { file: 'fixture.test.ts', baseline: 0, current: 1, delta: 1 },
      { dirtyPathCount: 0 },
    );
    expect(text).toMatch(/COMMITTED/i);
    expect(text).toMatch(/WILL red the fleet/i);
    expect(text).not.toMatch(/causal origin unresolved/i);
  });

  // EI-19340874432965755 — WI-6928's exact shape: the named file had been unchanged since 01:21
  // with no commits since the report, so its content never varied and the cause was elsewhere.
  // Two of three agents were sent into a file like this by the flat "COMMITTED" wording.
  describe('a file that has not changed must not be named as the cause', () => {
    const ROW = { file: 'innocent.ts', baseline: 0, current: 3, delta: 3 };

    it('marks a long-unchanged file UNCHANGED and points away from it, not at it', () => {
      const text = formatStandingRedRow(ROW, {
        dirtyPathCount: 0,
        commitAgeSec: LANDING_RACE_WINDOW_SEC + 1,
      });
      expect(text).toMatch(/UNCHANGED/);
      expect(text).toMatch(/cause is a change ELSEWHERE/i);
      expect(text).not.toContain('← COMMITTED:');
      expect(text).not.toMatch(/WILL red the fleet/i);
    });

    it("prefers the file's OWN commit age over the tree-wide dirty count", () => {
      // Both signals apply. The commit age is about THIS file and is the more actionable of the
      // two, so it must win — on this shared checkout dirtyPathCount is ~always non-zero, which
      // would otherwise mask the stronger reading behind a permanently-true one.
      const text = formatStandingRedRow(ROW, {
        dirtyPathCount: 1291,
        commitAgeSec: LANDING_RACE_WINDOW_SEC + 1,
      });
      expect(text).toMatch(/UNCHANGED/);
      expect(text).not.toMatch(/causal origin unresolved/i);
    });

    it('NEVER exonerates on unknown: a null commit age keeps the loud reading', () => {
      // lastCommitTimes fails soft to null, and a submodule path reads null from the superproject.
      // Treating either as "unchanged" would manufacture an exoneration from absent evidence.
      const text = formatStandingRedRow(ROW, { dirtyPathCount: 0, commitAgeSec: null });
      expect(text).toMatch(/COMMITTED/i);
      expect(text).not.toMatch(/UNCHANGED/);
    });

    it('does not mark a JUST-committed file unchanged (that is the landing-race case)', () => {
      const text = formatStandingRedRow(ROW, {
        dirtyPathCount: 0,
        commitAgeSec: LANDING_RACE_WINDOW_SEC - 1,
      });
      expect(text).not.toMatch(/UNCHANGED/);
      expect(text).toMatch(/COMMITTED/i);
    });

    it('shares ONE predicate with the caller so rows and the footer count cannot disagree', () => {
      expect(isUnchangedForAttribution(null)).toBe(false);
      expect(isUnchangedForAttribution(LANDING_RACE_WINDOW_SEC - 1)).toBe(false);
      expect(isUnchangedForAttribution(LANDING_RACE_WINDOW_SEC + 1)).toBe(true);
    });
  });

  describe('the footer names the tool that finds the real cause (EI-19340874432965755 proposal 3)', () => {
    it('points at lint:required-field-strands when a row is unchanged', () => {
      const text = formatStandingRedFooter({ unchangedCount: 2 }).join('\n');
      expect(text).toMatch(/lint:required-field-strands/);
      expect(text).toMatch(/IMPORT GRAPH/i);
      expect(text).toMatch(/SURFACES, not where it ORIGINATES/i);
    });

    it('stays silent about it when nothing is unchanged', () => {
      // The pointer is advice for one specific situation; printing it unconditionally would train
      // readers to skip the footer, which is where the do-not-hand-file contract also lives.
      const text = formatStandingRedFooter({ unchangedCount: 0 }).join('\n');
      expect(text).not.toMatch(/lint:required-field-strands/);
      expect(text).toMatch(/do NOT hand-file/i);
    });
  });

  it('formatNewFileGuidance says "new" means absent-from-baseline, not recently written', () => {
    // The prose companion to the row wording above. Before this it flatly asserted "COMMITTED — a
    // standing red", contradicting the row formatter's own causal caveat in the same report.
    const text = formatNewFileGuidance({ explicit: true, liveEditCount: 0, standingCount: 1 }).join('\n');
    expect(text).toMatch(/ABSENT FROM THE BASELINE, not recently written/i);
    expect(text).toMatch(/lint:required-field-strands/);
  });

  it('NEVER greenwashes: a dirty peer new-file still fails the run', () => {
    // The one invariant this change must not break (tsc-baseline-gate.mjs: "Never greenwash this
    // one"). Attribution softens; the verdict does not.
    const r = decidePerFile({
      currentByFile: { 'peer-new.ts': 5 },
      baselineByFile: {},
      brokenFiles: brokenFree,
      changedFiles: new Set(['mine.ts']),
      dirtyFiles: new Set(['peer-new.ts']),
    });
    expect(r.verdict).toBe('fail-new-file');
  });

  it('splits new files into live peer edits vs standing reds', () => {
    const { liveEdits, standing } = partitionNewFilesByLiveEdit([
      { file: 'peer-new.ts', baseline: 0, current: 5, delta: 5, dirty: true },
      { file: 'landed-new.ts', baseline: 0, current: 2, delta: 2, dirty: false },
    ]);
    expect(liveEdits.map((x: { file: string }) => x.file)).toEqual(['peer-new.ts']);
    expect(standing.map((x: { file: string }) => x.file)).toEqual(['landed-new.ts']);
  });

  it('treats an unknown dirty state as standing — never invents an exoneration', () => {
    // dirtyFiles was unavailable (git failed, or --mine): `dirty` is undefined. The safe reading is
    // "cannot show it is a live edit", so it stays in the loud bucket.
    const { liveEdits, standing } = partitionNewFilesByLiveEdit([
      { file: 'unknown.ts', baseline: 0, current: 1, delta: 1 },
    ]);
    expect(liveEdits).toEqual([]);
    expect(standing.map((x: { file: string }) => x.file)).toEqual(['unknown.ts']);
  });

  it('guidance tells the caller a live edit is NOT theirs and not to edit it', () => {
    const text = formatNewFileGuidance({ explicit: true, liveEditCount: 1, standingCount: 0 }).join('\n');
    expect(text).toMatch(/uncommitted|mid-edit/i);
    expect(text).toMatch(/not attributed to you|isn’t yours|not yours/i);
    // The actively harmful instruction the old text gave for this case.
    expect(text).not.toMatch(/If one is yours, fix it/i);
  });

  it('guidance still says "fix it" when the new file is a committed standing red', () => {
    const text = formatNewFileGuidance({ explicit: true, liveEditCount: 0, standingCount: 1 }).join('\n');
    expect(text).toMatch(/fix/i);
    expect(text).not.toMatch(/mid-edit/i);
  });

  it('with NO split supplied, falls back to the full standing text (unknown ⇒ loud)', () => {
    // Caught by the pre-existing EI-18802204276510164 tests when this split was first added: with
    // both counts defaulting to 0 the guidance collapsed to a single line, silently dropping the
    // "outside the --files set" explanation and the tell-the-author remedy. Same rule as
    // partitionNewFilesByLiveEdit — absence of evidence is never evidence of a live edit.
    const text = formatNewFileGuidance({ explicit: true }).join('\n');
    expect(text).toMatch(/set you named|outside the .*--files.* set/i);
    expect(text).toMatch(/author/i);
    expect(text).not.toMatch(/mid-edit/i);
  });

  it('keeps the EI-18802204276510164 fix: never re-prescribes --files to a --files caller', () => {
    for (const opts of [
      { explicit: true, liveEditCount: 1, standingCount: 0 },
      { explicit: true, liveEditCount: 0, standingCount: 1 },
      { explicit: true, liveEditCount: 1, standingCount: 1 },
    ]) {
      expect(formatNewFileGuidance(opts).join('\n')).not.toMatch(/re-run with --files/i);
    }
  });
});

describe('new-file reds: the count alone withholds the diagnosis (WI-6767)', () => {
  // WHY THIS EXISTS. The `fail-new-file` report said `file: 0 → 1 (+1)` and stopped. Recovering the
  // actual message from that costs a fresh full-project compile (~100s here under contention), so
  // the WI-6764 filer recorded — verbatim — that they could not capture the TSxxxx because a full
  // `tsc -p packages/operator-core` blew their shell budget TWICE, and filed a major bug without
  // ever seeing the error. The next agent then spent ~20 minutes re-deriving it. The line was in a
  // string the gate already held.
  const SAMPLE = [
    "lib/a.ts(10,3): error TS2322: Type '\"memory-recall-scale\"' is not assignable to type 'WatchdogSource'.",
    'lib/a.ts(11,3): error TS2339: Property x does not exist.',
    'lib/a.ts(12,3): error TS2339: Property y does not exist.',
    'lib/a.ts(13,3): error TS2339: Property z does not exist.',
    'lib/other.ts(1,1): error TS2554: Expected 1 arguments.',
    'error TS5042: Option project cannot be mixed with source files.',
  ].join('\n');

  it('quotes the real compiler lines for the requested files only', () => {
    const got = diagnosticLinesForFiles(SAMPLE, ['lib/a.ts']);
    expect([...got.keys()]).toEqual(['lib/a.ts']);
    // The message — not just the code — is what makes a landing race self-evident: it names a type
    // that lives in a DIFFERENT file.
    expect(got.get('lib/a.ts')![0]).toContain("not assignable to type 'WatchdogSource'");
  });

  it('caps the quote per file so one noisy file cannot bury the guidance', () => {
    expect(diagnosticLinesForFiles(SAMPLE, ['lib/a.ts']).get('lib/a.ts')).toHaveLength(3);
    expect(diagnosticLinesForFiles(SAMPLE, ['lib/a.ts'], { maxPerFile: 1 }).get('lib/a.ts')).toHaveLength(1);
  });

  it('asks for nothing → returns nothing, and never attributes a global (unattributed) error', () => {
    expect(diagnosticLinesForFiles(SAMPLE, []).size).toBe(0);
    // TS5042 has no file; it must not be smuggled under some file's heading.
    const all = diagnosticLinesForFiles(SAMPLE, ['lib/a.ts', 'lib/other.ts']);
    expect([...all.values()].flat().join('\n')).not.toContain('TS5042');
  });

  it('cannot drift from the counter: every file counted +N can produce its lines', () => {
    // The anti-drift pin. Both read the same LOCATED_DIAGNOSTIC grammar, so a file that shows a
    // count in the summary must be quotable — otherwise the report would print "+1" above silence.
    const counted = Object.keys(countByFile(parseTscErrors(SAMPLE))).filter((f) => f !== '(unattributed)');
    const quoted = diagnosticLinesForFiles(SAMPLE, counted);
    for (const file of counted) expect(quoted.get(file)?.length ?? 0).toBeGreaterThan(0);
  });
});

describe('formatRegressedFileDiagnostics — quote the lines, never overclaim which are new (EI-19454211066351073)', () => {
  // WHY THIS EXISTS. The gate printed `x.ts: 0 → 1  (+1)` and nothing else: no code, no line, no
  // message. It had already run tsc and already parsed it per-file — that is where the delta comes
  // from — and then discarded the diagnostics, so the only way to learn WHAT broke was a second
  // full ~150s compile queued behind pc-heavy.
  //
  // The trap this block guards is the FIX, not the omission. A file at `2 → 4` has a mixture of
  // pre-existing and new errors, and the baseline stores only a COUNT — so nothing here knows
  // WHICH two are new. Diagnostics arrive in line order, so quoting the first N can show only
  // pre-existing errors and never the regression. A reader handed three plausible errors, none of
  // them theirs, does not notice: they fix a pre-existing one and read the still-red gate as
  // flaky. That is strictly worse than the silence it replaced, because it is confidently wrong.
  const LINES = [
    "lib/a.ts(10,3): error TS2322: Type 'string' is not assignable to type 'number'.",
    'lib/a.ts(11,3): error TS2339: Property x does not exist.',
  ];

  it('quotes the compiler lines beneath the row', () => {
    const out = formatRegressedFileDiagnostics({ file: 'lib/a.ts', baseline: 0, current: 2, delta: 2 }, LINES).join('\n');
    expect(out).toContain("Type 'string' is not assignable to type 'number'");
    expect(out).toContain('TS2339');
  });

  it('baseline 0 → says outright that every quoted error is new', () => {
    const out = formatRegressedFileDiagnostics({ file: 'lib/a.ts', baseline: 0, current: 2, delta: 2 }, LINES).join('\n');
    expect(out).toContain('baseline is 0');
    expect(out).toContain('every error above is new');
  });

  it('baseline 0 + dirty → warns about the live edit instead of claiming every error is new', () => {
    const out = formatRegressedFileDiagnostics(
      { file: 'lib/a.ts', baseline: 0, current: 2, delta: 2, dirty: true },
      LINES,
    ).join('\n');
    expect(out).toMatch(/uncommitted.*peer is likely mid-edit/i);
    expect(out).toContain('baseline is 0');
    expect(out).not.toContain('every error above is new');
  });

  it('baseline > 0 → names how many PRE-DATE the change and how many are new', () => {
    const out = formatRegressedFileDiagnostics({ file: 'lib/a.ts', baseline: 2, current: 4, delta: 2 }, LINES).join('\n');
    expect(out).toContain('2 of this file');
    expect(out).toContain('PRE-DATE');
    expect(out).toContain('2 new one(s)');
  });

  // THE CONTROL. This is the assertion that fails if someone later "simplifies" the caveat into a
  // claim of newness — the exact regression that would restore the trap described above.
  it('baseline > 0 → NEVER claims the quoted lines are the new ones', () => {
    const out = formatRegressedFileDiagnostics({ file: 'lib/a.ts', baseline: 2, current: 4, delta: 2 }, LINES).join('\n');
    expect(out).not.toContain('every error above is new');
    // It must say the split is undecidable rather than implying an order.
    expect(out).toContain('NOT mechanically');
  });

  it('flags the remainder when the per-file cap truncates the quote', () => {
    const out = formatRegressedFileDiagnostics({ file: 'lib/a.ts', baseline: 0, current: 9, delta: 9 }, LINES).join('\n');
    expect(out).toContain('+7 more error(s)');
  });

  it('quotes nothing → emits nothing (no orphan caveat under a row with no lines)', () => {
    expect(formatRegressedFileDiagnostics({ file: 'lib/a.ts', baseline: 2, current: 4, delta: 2 }, [])).toEqual([]);
  });

  it('the regressed cap is larger than the new-file cap, because the sets differ in kind', () => {
    // A new file's errors are homogeneous (all new); a regressed file's are a mixture the reader
    // must search. Cutting the mixture at 3 is what hides the line the report exists to surface.
    expect(REGRESSION_DIAGNOSTIC_MAX_PER_FILE).toBeGreaterThan(3);
  });
});

describe('diagnosticCapFromArgv — the per-file quote cap and its escape hatch (EI-19343733961745670)', () => {
  it('returns the caller default when the flag is absent', () => {
    expect(diagnosticCapFromArgv(['--files=lib/a.ts'], REGRESSION_DIAGNOSTIC_MAX_PER_FILE)).toBe(
      REGRESSION_DIAGNOSTIC_MAX_PER_FILE,
    );
    expect(diagnosticCapFromArgv([], 3)).toBe(3);
  });

  it('returns Infinity under --all-errors, whatever the default was', () => {
    expect(diagnosticCapFromArgv([ALL_ERRORS_FLAG], 3)).toBe(Number.POSITIVE_INFINITY);
    expect(
      diagnosticCapFromArgv(['--files=lib/a.ts', ALL_ERRORS_FLAG], REGRESSION_DIAGNOSTIC_MAX_PER_FILE),
    ).toBe(Number.POSITIVE_INFINITY);
  });

  // A missing argv must not silently become "uncapped" — the gate passes it straight through from
  // its caller, and an undefined there is a wiring mistake, not a request for every error.
  it('falls back to the default rather than throwing when argv is not an array', () => {
    expect(diagnosticCapFromArgv(undefined, 7)).toBe(7);
  });

  // The flag name is asserted rather than inlined: it appears in the CLI usage text and in the
  // gate's report, so a rename that misses one of those should fail here.
  it('is spelled --all-errors', () => {
    expect(ALL_ERRORS_FLAG).toBe('--all-errors');
  });
});

describe('the gate REPORT actually prints the diagnostics (wiring, EI-19454211066351073)', () => {
  // WHY A SUBPROCESS. The formatter above is pure and well-covered, but a pure formatter nobody
  // CALLS prints nothing — and "the helper exists" was already true before this fix: the gate had
  // `diagnosticLinesForFiles` and used it in the new-file branch ONLY, which is exactly why the
  // regression branches stayed silent. So the property under test is the WIRING, and the only
  // honest way to test it is to run the real gate and read its real output. `runTscBaselineGate`
  // registers a process exit-handler and calls process.exit, so it cannot run in-process here.
  //
  // `tscCommand` is injectable and executed through a shell, so `cat <fixture>` stands in for the
  // ~150s compile: the gate parses canned compiler output exactly as it parses tsc's.
  const REPO_ROOT_W = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const GATE = pathToFileURL(join(REPO_ROOT_W, 'scripts', 'lib', 'tsc-baseline-gate.mjs')).href;

  const TSC_LINES = [
    "lib/a.ts(10,3): error TS2322: Type 'string' is not assignable to type 'number'.",
    'lib/a.ts(11,3): error TS2339: Property x does not exist.',
  ].join('\n');

  const TS1XXX_HARD_FAIL_TSC_LINES =
    "lib/a.ts(597,60): error TS1320: Type of 'await' operand must either be a valid promise or must not contain a callable 'then' member.";

  /** Run the real gate over canned compiler output; returns its combined output. */
  function runGate(baseline: Record<string, number>, extraFile?: { path: string; diagnostic: string }): string {
    const root = mkdtempSync(join(tmpdir(), 'tsc-gate-wiring-'));
    try {
      mkdirSync(join(root, 'lib'), { recursive: true });
      writeFileSync(join(root, 'lib/a.ts'), 'export const fixture = 1;\n');
      if (extraFile) writeFileSync(join(root, extraFile.path), 'export const peerFixture = 1;\n');
      writeFileSync(join(root, 'tsc-output.txt'), `${TSC_LINES}\n${extraFile?.diagnostic ?? ''}\n`);
      // The baseline is `{ files: {...} }`, not a flat map. Writing a flat map here made the
      // gate read NO baseline at all and default the file to 0 — which still produced a green
      // "0 → 2" for the baseline-0 case, i.e. the test would have passed for the wrong reason.
      writeFileSync(join(root, 'baseline.json'), JSON.stringify({ files: baseline }));
      writeFileSync(
        join(root, 'run.mjs'),
        `import { runTscBaselineGate } from ${JSON.stringify(GATE)};\n` +
          // Top-level await: the gate is async (it may import sibling gate modules to resolve
          // coverage, EI-19461218392796337). Without the await an unhandled rejection would
          // surface as a bare node error instead of the gate output under test.
          `await runTscBaselineGate({\n` +
          `  root: ${JSON.stringify(root)},\n` +
          `  tscCommand: ${JSON.stringify(`cat ${join(root, 'tsc-output.txt')}`)},\n` +
          `  baselineFile: ${JSON.stringify(join(root, 'baseline.json'))},\n` +
          `  label: 'test',\n` +
          `  argv: ['--files=lib/a.ts'],\n` +
          `});\n`,
      );
      try {
        return execFileSync('node', [join(root, 'run.mjs')], { encoding: 'utf-8', stdio: 'pipe' });
      } catch (e: any) {
        // The gate exits 1 on a regression — that IS the path under test, not a failure.
        return `${e.stdout ?? ''}${e.stderr ?? ''}`;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  /** Run the real gate over a canned TS1xxx compiler failure; returns its combined output. */
  function runSyntaxGate(): string {
    const root = mkdtempSync(join(tmpdir(), 'tsc-gate-syntax-wiring-'));
    try {
      mkdirSync(join(root, 'lib'), { recursive: true });
      writeFileSync(join(root, 'lib/a.ts'), 'export const fixture = 1;\n');
      writeFileSync(join(root, 'tsc-output.txt'), `${TS1XXX_HARD_FAIL_TSC_LINES}\n`);
      writeFileSync(join(root, 'baseline.json'), JSON.stringify({ files: { 'lib/a.ts': 0 } }));
      writeFileSync(
        join(root, 'run.mjs'),
        `import { runTscBaselineGate } from ${JSON.stringify(GATE)};\n` +
          `await runTscBaselineGate({\n` +
          `  root: ${JSON.stringify(root)},\n` +
          `  tscCommand: ${JSON.stringify(`cat ${join(root, 'tsc-output.txt')}`)},\n` +
          `  baselineFile: ${JSON.stringify(join(root, 'baseline.json'))},\n` +
          `  label: 'test',\n` +
          `  argv: ['--files=lib/a.ts'],\n` +
          `});\n`,
      );
      try {
        return execFileSync('node', [join(root, 'run.mjs')], { encoding: 'utf-8', stdio: 'pipe' });
      } catch (e: any) {
        // The gate exits 1 on a TS1xxx hard failure — that IS the path under test, not a test failure.
        return `${e.stdout ?? ''}${e.stderr ?? ''}`;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // EI-19340874432965755 — the WIRING, not the formatters. The pure-function tests above prove
  // formatStandingRedRow can say UNCHANGED; only this proves the gate actually reaches git,
  // computes the age, and threads it into both the row and the footer count. The temp root must
  // be a REAL repo with a REAL backdated commit, because `lastCommitTimes` shells `git log -1`:
  // in a non-repo it fails soft to null, every row reads UNKNOWN, and a test that skipped this
  // setup would pass against code that never wired the age through at all.
  it('names a long-unchanged standing file UNCHANGED and points at the strands tool', () => {
    const root = mkdtempSync(join(tmpdir(), 'tsc-gate-unchanged-'));
    try {
      const git = (args: string[], env?: Record<string, string>) =>
        execFileSync('git', args, { cwd: root, encoding: 'utf-8', env: { ...process.env, ...env } });
      git(['init', '-q']);
      git(['config', 'user.email', 'gate-test@example.invalid']);
      git(['config', 'user.name', 'gate test']);
      mkdirSync(join(root, 'lib'), { recursive: true });
      writeFileSync(join(root, 'lib/old-peer.ts'), 'export const x = 1;\n');
      writeFileSync(join(root, 'lib/a.ts'), 'export const fixture = 1;\n');
      // Backdate well past LANDING_RACE_WINDOW_SEC so the file is unambiguously "settled".
      const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'old', '--date', old], { GIT_COMMITTER_DATE: old });

      writeFileSync(
        join(root, 'tsc-output.txt'),
        [
          // A baseline file that regressed and is NOT in the named set → verdict ok-peer-drift.
          'lib/drift.ts(1,1): error TS2322: drifted.',
          'lib/drift.ts(2,1): error TS2339: drifted again.',
          // A file ABSENT from the baseline, committed and long settled → the row under test.
          'lib/old-peer.ts(3,1): error TS2322: surfaced here, caused elsewhere.',
        ].join('\n') + '\n',
      );
      writeFileSync(
        join(root, 'baseline.json'),
        JSON.stringify({ files: { 'lib/a.ts': 0, 'lib/drift.ts': 1 } }),
      );
      writeFileSync(
        join(root, 'run.mjs'),
        `import { runTscBaselineGate } from ${JSON.stringify(GATE)};\n` +
          `await runTscBaselineGate({\n` +
          `  root: ${JSON.stringify(root)},\n` +
          `  tscCommand: ${JSON.stringify(`cat ${join(root, 'tsc-output.txt')}`)},\n` +
          `  baselineFile: ${JSON.stringify(join(root, 'baseline.json'))},\n` +
          `  label: 'test',\n` +
          `  argv: ['--files=lib/a.ts'],\n` +
          `});\n`,
      );
      // The test runner preloads committed-source-loader, which also guards this child process.
      // Give the generated driver a committed version before invoking Node.
      git(['add', 'run.mjs']);
      git(['commit', '-q', '-m', 'commit fixture runner']);
      let out: string;
      try {
        out = execFileSync('node', [join(root, 'run.mjs')], { encoding: 'utf-8', stdio: 'pipe' });
      } catch (e: any) {
        out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
      }

      expect(out).toContain('lib/old-peer.ts');
      expect(out).toMatch(/UNCHANGED/);
      // The whole point: it must NOT tell the reader this file is the standing red to go fix.
      expect(out).not.toMatch(/lib\/old-peer\.ts.*COMMITTED: a standing red/);
      // ...and it must say where to look instead.
      expect(out).toMatch(/lint:required-field-strands/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a regression in a NAMED file prints the compiler message, not just the count', () => {
    const out = runGate({ 'lib/a.ts': 0 });
    // The count line the gate always printed...
    expect(out).toContain('lib/a.ts: 0 → 2');
    // ...and the message it used to discard, which is the whole point of the item.
    expect(out).toContain("Type 'string' is not assignable to type 'number'");
    expect(out).toContain('every error above is new');
  });

  it('a MIXED file states how many pre-date the change instead of implying all are yours', () => {
    const out = runGate({ 'lib/a.ts': 1 });
    expect(out).toContain('lib/a.ts: 1 → 2');
    expect(out).toContain('PRE-DATE');
    expect(out).not.toContain('every error above is new');
  });

  it('prints new-file diagnostics alongside an attributed regression without another compile', () => {
    const diagnostic = "lib/new-peer.ts(7,4): error TS2339: Property 'peerOnly' does not exist on type '{}'.";
    const out = runGate({ 'lib/a.ts': 0 }, { path: 'lib/new-peer.ts', diagnostic });
    expect(out).toContain('lib/a.ts: 0 → 2');
    expect(out).toContain('also 1 NEW file(s) with errors');
    expect(out).toContain('lib/new-peer.ts: 0 → 1');
    expect(out).toContain(diagnostic);
    expect(out).toContain('status=regressed');
  });

  it('a TS1xxx hard failure prints the compiler message without calling it a parse error', () => {
    const out = runSyntaxGate();
    expect(out).toContain('lib/a.ts');
    expect(out).toContain(TS1XXX_HARD_FAIL_TSC_LINES);
    expect(out).toContain('hard-failing TS1xxx diagnostics');
    expect(out).not.toContain('parse errors');
  });

  // EI-19343733961745670 — the cap and its escape hatch, proved on ONE fixture run twice. The
  // pure `diagnosticCapFromArgv` tests below can only show the number changes; they cannot show
  // the gate THREADS it, and a flag that is parsed but never reaches `diagnosticLinesForFiles`
  // fails in the direction that misleads — `--all-errors` returning a capped block reads as "that
  // is all of them" and nothing in the output contradicts it. So the default run is the negative
  // control: it must still truncate, or an always-uncapped gate would pass the positive case too.
  const TWELVE_ERROR_LINES = Array.from(
    { length: 12 },
    (_, i) => `lib/a.ts(${i + 1},3): error TS2322: distinct message number ${i + 1}.`,
  );

  /** Run the real gate over a 12-error fixture, with whatever extra argv the case needs. */
  function runGateWithTwelveErrors(extraArgv: string[]): string {
    const root = mkdtempSync(join(tmpdir(), 'tsc-gate-cap-'));
    try {
      mkdirSync(join(root, 'lib'), { recursive: true });
      writeFileSync(join(root, 'lib/a.ts'), 'export const fixture = 1;\n');
      writeFileSync(join(root, 'tsc-output.txt'), `${TWELVE_ERROR_LINES.join('\n')}\n`);
      writeFileSync(join(root, 'baseline.json'), JSON.stringify({ files: { 'lib/a.ts': 0 } }));
      const argv = JSON.stringify(['--files=lib/a.ts', ...extraArgv]);
      writeFileSync(
        join(root, 'run.mjs'),
        `import { runTscBaselineGate } from ${JSON.stringify(GATE)};\n` +
          `await runTscBaselineGate({\n` +
          `  root: ${JSON.stringify(root)},\n` +
          `  tscCommand: ${JSON.stringify(`cat ${join(root, 'tsc-output.txt')}`)},\n` +
          `  baselineFile: ${JSON.stringify(join(root, 'baseline.json'))},\n` +
          `  label: 'test',\n` +
          `  argv: ${argv},\n` +
          `});\n`,
      );
      try {
        return execFileSync('node', [join(root, 'run.mjs')], { encoding: 'utf-8', stdio: 'pipe' });
      } catch (e: any) {
        return `${e.stdout ?? ''}${e.stderr ?? ''}`;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('caps a many-error file by default and SAYS how many it withheld', () => {
    const out = runGateWithTwelveErrors([]);
    expect(out).toContain('distinct message number 10.');
    expect(out).not.toContain('distinct message number 11.');
    expect(out).not.toContain('distinct message number 12.');
    // The footer is what keeps the cap honest — silence here would read as "that is all of them".
    expect(out).toContain('+2 more error(s) in this file not shown');
  });

  it('--all-errors lifts the cap and drops the withheld-count footer', () => {
    const out = runGateWithTwelveErrors(['--all-errors']);
    for (const line of TWELVE_ERROR_LINES) {
      expect(out).toContain(line.slice(line.indexOf('error TS')));
    }
    expect(out).not.toContain('more error(s) in this file not shown');
  });

  it('forwards pc-heavy stderr while preserving captured compiler output', () => {
    const root = mkdtempSync(join(tmpdir(), 'tsc-gate-stderr-'));
    try {
      mkdirSync(join(root, 'scripts'));
      mkdirSync(join(root, 'lib'), { recursive: true });
      writeFileSync(join(root, 'lib/a.ts'), 'export const fixture = 1;\n');
      writeFileSync(
        join(root, 'scripts', 'pc-heavy.sh'),
        '#!/usr/bin/env bash\nprintf "%s\\n" "pc-heavy: waiting for compile slot" >&2\nexec "$@"\n',
      );
      writeFileSync(join(root, 'tsc-output.txt'), `${TSC_LINES}\n`);
      writeFileSync(join(root, 'baseline.json'), JSON.stringify({ files: { 'lib/a.ts': 0 } }));
      writeFileSync(
        join(root, 'run.mjs'),
        `import { runTscBaselineGate } from ${JSON.stringify(GATE)};\n` +
          `await runTscBaselineGate({\n` +
          `  root: ${JSON.stringify(root)},\n` +
          `  tscCommand: ${JSON.stringify(`cat ${join(root, 'tsc-output.txt')}`)},\n` +
          `  baselineFile: ${JSON.stringify(join(root, 'baseline.json'))},\n` +
          `  label: 'test',\n` +
          `  argv: ['--files=lib/a.ts'],\n` +
          `});\n`,
      );
      let out = '';
      try {
        execFileSync('node', [join(root, 'run.mjs')], { encoding: 'utf-8', stdio: 'pipe' });
      } catch (e: any) {
        out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
      }
      expect(out).toContain('pc-heavy: waiting for compile slot');
      expect(out).toContain('lib/a.ts: 0 → 2');
      expect(out).toContain("Type 'string' is not assignable to type 'number'");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a first seed preserves foreign-baseline inheritance (EI-21159980101594599)', () => {
  // This is intentionally a real subprocess around runTscBaselineGate rather than a pure helper
  // test: the defect lived in the production ordering of baseline loading and the --seed write.
  // A unit test of effectiveBaselineByFile alone cannot catch a seed branch that returns before
  // that helper is ever called.
  const REPO_ROOT_S = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const GATE_S = pathToFileURL(join(REPO_ROOT_S, 'scripts', 'lib', 'tsc-baseline-gate.mjs')).href;

  it('inherits owner-baselined files while retaining consumer-context-only foreign diagnostics', () => {
    const root = mkdtempSync(join(tmpdir(), 'tsc-gate-seed-inheritance-'));
    const baselineFile = join(root, 'baseline.json');
    const foreignBaselineFile = join(root, 'operator-core-baseline.json');
    try {
      writeFileSync(
        join(root, 'tsc-output.txt'),
        [
          "packages/agent-mcp/src/own.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
          'packages/operator-core/lib/owned.ts(2,1): error TS2339: Property x does not exist.',
          'packages/operator-core/lib/context-only.ts(3,1): error TS2339: Property y does not exist.',
        ].join('\n') + '\n',
      );
      writeFileSync(baselineFile, JSON.stringify({ files: {} }));
      writeFileSync(
        foreignBaselineFile,
        JSON.stringify({ files: { 'packages/operator-core/lib/owned.ts': 1 } }),
      );
      writeFileSync(
        join(root, 'run.mjs'),
        `import { runTscBaselineGate } from ${JSON.stringify(GATE_S)};\n` +
          `await runTscBaselineGate({\n` +
          `  root: ${JSON.stringify(root)},\n` +
          `  tscCommand: ${JSON.stringify(`cat ${join(root, 'tsc-output.txt')}`)},\n` +
          `  baselineFile: ${JSON.stringify(baselineFile)},\n` +
          `  label: 'agent-mcp-seed-test',\n` +
          `  argv: ['--seed'],\n` +
          `  foreignBaselines: [{\n` +
          `    prefix: 'packages/operator-core/',\n` +
          `    baselineFile: ${JSON.stringify(foreignBaselineFile)},\n` +
          `    label: 'operator-core',\n` +
          `  }],\n` +
          `});\n`,
      );

      execFileSync('node', [join(root, 'run.mjs')], { encoding: 'utf-8', stdio: 'pipe' });
      const seeded = JSON.parse(readFileSync(baselineFile, 'utf-8')) as {
        errorCount?: number;
        files: Record<string, number>;
      };
      expect(seeded.files).toEqual({
        'packages/agent-mcp/src/own.ts': 1,
        'packages/operator-core/lib/context-only.ts': 1,
      });
      expect(seeded.errorCount).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to seed when an owning baseline is unreadable', () => {
    const root = mkdtempSync(join(tmpdir(), 'tsc-gate-seed-missing-owner-'));
    const baselineFile = join(root, 'baseline.json');
    try {
      writeFileSync(
        join(root, 'tsc-output.txt'),
        'packages/operator-core/lib/owned.ts(2,1): error TS2339: Property x does not exist.\n',
      );
      writeFileSync(baselineFile, JSON.stringify({ files: {} }));
      writeFileSync(
        join(root, 'run.mjs'),
        `import { runTscBaselineGate } from ${JSON.stringify(GATE_S)};\n` +
          `await runTscBaselineGate({\n` +
          `  root: ${JSON.stringify(root)},\n` +
          `  tscCommand: ${JSON.stringify(`cat ${join(root, 'tsc-output.txt')}`)},\n` +
          `  baselineFile: ${JSON.stringify(baselineFile)},\n` +
          `  label: 'missing-owner-seed-test',\n` +
          `  argv: ['--seed'],\n` +
          `  foreignBaselines: [{\n` +
          `    prefix: 'packages/operator-core/',\n` +
          `    baselineFile: ${JSON.stringify(join(root, 'missing-owner-baseline.json'))},\n` +
          `    label: 'operator-core',\n` +
          `  }],\n` +
          `});\n`,
      );

      expect(() =>
        execFileSync('node', [join(root, 'run.mjs')], { encoding: 'utf-8', stdio: 'pipe' }),
      ).toThrow();
      expect(JSON.parse(readFileSync(baselineFile, 'utf-8'))).toEqual({ files: {} });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a crashed tsc with non-empty garbage output must NOT read as clean (WI-37485)', () => {
  // WHY THIS EXISTS. Confirmed live against green-checkpoint candidate b15ff819ad2e (a real,
  // committed TS2741 in federated-presence.ts): `npx tsc -p packages/operator-core/tsconfig.json
  // --noEmit --incremental false` OOM-crashed under real fleet memory pressure (V8 "FATAL ERROR:
  // Ineffective mark-compacts near heap limit ... JavaScript heap out of memory", SIGABRT, exit
  // 134) — reproduced THREE times in one sitting, both with pc-heavy coalescing on and fully
  // disabled, ruling out the cache as the cause. The crash trace is non-empty, so the pre-existing
  // `tscThrew && !tscOutput` guard (which only catches a totally EMPTY crash) never fires;
  // `parseTscErrors` then — correctly, per its own contract — finds zero "file.ts(l,c): error
  // TSxxxx:" lines in a V8 native stack trace and returns `[]`. That empty list reads as "every
  // baselined file improved to 0 errors", i.e. the gate reports the candidate CLEAN despite the
  // real, un-fixed TS2741 never having been type-checked at all.
  //
  // `tscCommand` is injectable and shell-executed (see the wiring describe block above) — a canned
  // command that prints non-diagnostic garbage and exits non-zero stands in for the OOM crash
  // without needing to actually exhaust heap.
  const REPO_ROOT_C = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const GATE_C = pathToFileURL(join(REPO_ROOT_C, 'scripts', 'lib', 'tsc-baseline-gate.mjs')).href;

  /** Run the real gate with a canned tscCommand; returns its combined stdout+stderr. */
  function runGateWithCommand(tscCommand: string, baseline: Record<string, number>): string {
    const root = mkdtempSync(join(tmpdir(), 'tsc-gate-crash-'));
    try {
      writeFileSync(join(root, 'baseline.json'), JSON.stringify({ files: baseline }));
      writeFileSync(
        join(root, 'run.mjs'),
        `import { runTscBaselineGate } from ${JSON.stringify(GATE_C)};\n` +
          `await runTscBaselineGate({\n` +
          `  root: ${JSON.stringify(root)},\n` +
          `  tscCommand: ${JSON.stringify(tscCommand)},\n` +
          `  baselineFile: ${JSON.stringify(join(root, 'baseline.json'))},\n` +
          `  label: 'test',\n` +
          `  argv: [],\n` +
          `});\n`,
      );
      try {
        return execFileSync('node', [join(root, 'run.mjs')], { encoding: 'utf-8', stdio: 'pipe' });
      } catch (e: any) {
        return `${e.stdout ?? ''}${e.stderr ?? ''}`;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // THE MUTANT this test exists to catch: a genuinely-cached pre-fix gate would print exactly this
  // (label is 'test' here, per runGateWithCommand — the real gate's own label is 'operator-core').
  const CLEAN_MUTANT = 'TSC test: 0 type errors across 0 file(s)';

  it('an OOM-shaped crash (non-empty garbage, non-zero exit) is reported as a toolchain failure, never clean', () => {
    const crashCmd =
      "(printf 'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - " +
      "JavaScript heap out of memory\\nAborted (core dumped)\\n'; exit 134)";
    const out = runGateWithCommand(crashCmd, { 'lib/a.ts': 3, 'lib/b.ts': 5 });
    expect(out).toContain('toolchain failure');
    expect(out).toContain('JavaScript heap out of memory');
    expect(out).not.toContain(CLEAN_MUTANT);
    expect(out).not.toContain('below baseline');
  });

  it('a genuinely EMPTY crash still hits the original (pre-existing) guard, unchanged', () => {
    const out = runGateWithCommand('exit 134', { 'lib/a.ts': 3 });
    expect(out).toContain('tsc produced no output');
    expect(out).not.toContain(CLEAN_MUTANT);
  });

  it('CONTROL: a real red (non-zero exit, real diagnostics) still parses and gates normally', () => {
    const realRed =
      "(printf 'lib/a.ts(10,3): error TS2322: Type mismatch.\\n'; exit 1)";
    const out = runGateWithCommand(realRed, { 'lib/a.ts': 0 });
    expect(out).not.toContain('toolchain failure');
    expect(out).toContain('lib/a.ts: 0 → 1');
  });

  it('CONTROL: a genuinely clean run (exit 0, no output) is still reported clean', () => {
    const out = runGateWithCommand('true', { 'lib/a.ts': 3 });
    expect(out).toContain(CLEAN_MUTANT);
  });
});

describe('new-file reds: COMMITTED does not mean SETTLED (WI-6767)', () => {
  // WHY THIS EXISTS. EI-19278299775574199 split new-file reds into a peer's UNCOMMITTED live edit
  // (don't touch) and a COMMITTED standing red (fix it now). That split is right — but it assumes
  // `committed` implies `settled`, and on this repo it does not: git-sync commits the WHOLE shared
  // tree on a schedule, so ONE logical multi-file change routinely lands across TWO ticks.
  //
  // Measured (WI-6764): commit 133317acd0 @20:25:57 landed a file emitting `source:
  // 'memory-recall-scale'`; the union accepting that value landed in watchdog.ts at 82a0d03bef
  // @20:33:46. For 7m49s the committed tree held exactly one real type error belonging to nobody.
  // An agent ran this gate inside that window, checked `git status` (clean), correctly concluded
  // "committed ⇒ standing red", and filed a major bug for something that had healed itself ~1
  // minute earlier. The reasoning was sound; the report had no way to say "wait a moment first".
  const NOW = 1_800_000_000;
  const row = (file: string) => ({ file, baseline: 0, current: 1, delta: 1 });

  it('flags a file committed inside the window as a possible landing race', () => {
    const { recent, settled } = partitionStandingByCommitRecency(
      [row('fresh.ts')],
      new Map([['fresh.ts', NOW - 120]]),
      NOW,
    );
    expect(recent.map((r: { file: string }) => r.file)).toEqual(['fresh.ts']);
    expect(settled).toEqual([]);
  });

  it('leaves a file committed long ago as a genuine standing red', () => {
    const { recent, settled } = partitionStandingByCommitRecency(
      [row('old.ts')],
      new Map([['old.ts', NOW - LANDING_RACE_WINDOW_SEC - 1]]),
      NOW,
    );
    expect(recent).toEqual([]);
    expect(settled.map((r: { file: string }) => r.file)).toEqual(['old.ts']);
  });

  it('treats an UNREADABLE commit time as standing — unknown is never an exoneration', () => {
    // The safety pin, and the same rule partitionNewFilesByLiveEdit applies. This caveat tells a
    // reader it is safe to WAIT rather than act, so it must be earned by positive evidence. A git
    // failure must not manufacture "probably fine, ignore it".
    const { recent, settled } = partitionStandingByCommitRecency(
      [row('unknown.ts')],
      new Map([['unknown.ts', null]]),
      NOW,
    );
    expect(recent).toEqual([]);
    expect(settled.map((r: { file: string }) => r.file)).toEqual(['unknown.ts']);
  });

  it('treats a MISSING entry and a future timestamp as standing too', () => {
    const { recent } = partitionStandingByCommitRecency(
      [row('absent.ts'), row('skewed.ts')],
      new Map([['skewed.ts', NOW + 5_000]]), // clock skew must not read as "just landed"
      NOW,
    );
    expect(recent).toEqual([]);
  });

  it('says nothing at all when no file is recent', () => {
    expect(formatLandingRaceCaveat({ recentCount: 0 })).toEqual([]);
  });

  it('tells the reader to re-run before filing, and never to ignore the failure', () => {
    const text = formatLandingRaceCaveat({ recentCount: 1 }).join('\n');
    expect(text).toMatch(/landing/i);
    expect(text).toMatch(/re-run/i);
    expect(text).toMatch(/before filing/i);
    // It must not greenwash: the run still failed, and this caveat is a diagnosis aid, not a
    // permission slip. "Never greenwash this one" is the invariant the whole new-file branch rests
    // on (EI-18766822535373909).
    expect(text).not.toMatch(/safe to ignore|you can ignore|not a real error|disregard/i);
  });
});

/**
 * EI-19341572300046923 — a scoped run must never report a verdict about files it never compiled.
 *
 * `--files=` scopes this gate's VERDICT; it does NOT widen what tsc compiles (`tscCommand` is a
 * per-project constant). So naming a file outside the project produced zero recorded errors for
 * it and a clean exit — a green that had typechecked nothing the caller asked about. The first
 * test below pins that underlying mechanism, so the guard can never be "simplified" away on the
 * belief that the old path was already safe.
 */
describe('EI-19341572300046923 — refusing a verdict about uncompiled files', () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

  it('MECHANISM: an out-of-project file yields a CLEAN verdict — why the pre-compile guard exists', () => {
    // tsc -p packages/operator-core never sees an operator-vite file, so it contributes no
    // diagnostics. Scoped to only that file, the per-file decision has nothing to fail on.
    const r = decidePerFile({
      currentByFile: { 'packages/operator-core/lib/real.ts': 2 },
      baselineByFile: { 'packages/operator-core/lib/real.ts': 2 },
      brokenFiles: [],
      changedFiles: new Set(['apps/operator-vite/src/components/adv/TasksRosterPanel.tsx']),
    });
    // Clean — indistinguishable from a genuine pass. THAT is the bug the guard prevents.
    expect(r.verdict).toBe('ok');
    expect(r.regressions).toEqual([]);
  });

  describe('projectPrefixFromTscCommand', () => {
    it('derives the compiled prefix from each real per-project command', () => {
      expect(projectPrefixFromTscCommand(TSC_COMMAND)).toBe('packages/operator-core/');
      expect(projectPrefixFromTscCommand(OPERATOR_VITE_TSC_COMMAND)).toBe('apps/operator-vite/');
    });

    it('returns null when no -p operand is parseable, so callers FAIL OPEN', () => {
      // Not knowing the prefix is not evidence a file lies outside it. A lint gate must never
      // invent a red it cannot substantiate.
      expect(projectPrefixFromTscCommand('npx tsc --noEmit')).toBeNull();
      expect(projectPrefixFromTscCommand('')).toBeNull();
      expect(projectPrefixFromTscCommand(undefined as unknown as string)).toBeNull();
    });

    it('treats a repo-root project as covering everything', () => {
      expect(projectPrefixFromTscCommand('npx tsc -p tsconfig.json --noEmit')).toBe('');
      expect(projectPrefixFromTscCommand('npx tsc -p . --noEmit')).toBe('');
    });
  });

  describe('partitionFilesByCoverage', () => {
    it('splits the named set into judgeable and not-judgeable', () => {
      const { covered, uncovered } = partitionFilesByCoverage({
        files: ['packages/operator-core/lib/a.ts', 'apps/operator-vite/src/b.tsx'],
        coveredPrefixes: ['packages/operator-core/'],
      });
      expect(covered).toEqual(['packages/operator-core/lib/a.ts']);
      expect(uncovered).toEqual(['apps/operator-vite/src/b.tsx']);
    });

    it('counts a FOREIGN baseline prefix as covered — operator-vite really does judge operator-core files', () => {
      // The SPA's type graph pulls operator-core in transitively (EI-18649014117371738), so those
      // files ARE measured by that gate. Flagging them would be a false alarm.
      const { covered, uncovered } = partitionFilesByCoverage({
        files: ['packages/operator-core/lib/a.ts'],
        coveredPrefixes: [
          'apps/operator-vite/',
          ...FOREIGN_BASELINES.map((b: { prefix: string }) => b.prefix),
        ],
      });
      expect(covered).toEqual(['packages/operator-core/lib/a.ts']);
      expect(uncovered).toEqual([]);
    });

    it('a repo-root project covers everything', () => {
      const { uncovered } = partitionFilesByCoverage({
        files: ['anywhere/at/all.ts'],
        coveredPrefixes: [''],
      });
      expect(uncovered).toEqual([]);
    });

    it('normalises a ./-prefixed path so it is not spuriously flagged', () => {
      const { covered } = partitionFilesByCoverage({
        files: ['./packages/operator-core/lib/a.ts'],
        coveredPrefixes: ['packages/operator-core/'],
      });
      expect(covered).toEqual(['packages/operator-core/lib/a.ts']);
    });

    it('uses actual program membership rather than a directory when membership is available', () => {
      expect(partitionFilesByCoverage({
        files: ['./scripts/included.ts', 'scripts/excluded.ts', 'scripts/test-files.mjs'],
        coveredPrefixes: ['scripts/'],
        programFiles: ['scripts/included.ts'],
      })).toEqual({
        covered: ['scripts/included.ts'],
        uncovered: ['scripts/excluded.ts', 'scripts/test-files.mjs'],
      });
    });
  });

  describe('normalizeExplicitFilesForProject (EI-21648762323304317)', () => {
    const coveredPrefixes = ['packages/operator-core/', 'apps/operator/'];
    const existing = new Set([
      'packages/operator-core/lib/goals/spend-rollup.ts',
      'packages/operator-core/lib/goals/spend-rollup.integration.test.ts',
      'apps/operator/lib/release/green-checkpoint.ts',
    ]);

    it('maps package-relative paths from a workspace cwd and preserves repo-relative paths', () => {
      expect(
        normalizeExplicitFilesForProject({
          files: [
            'lib/goals/spend-rollup.ts',
            'lib/goals/spend-rollup.integration.test.ts',
            'packages/operator-core/lib/goals/spend-rollup.ts',
            'apps/operator/lib/release/green-checkpoint.ts',
          ],
          root: '/repo',
          cwd: '/repo/packages/operator-core',
          coveredPrefixes,
          pathExists: (path: string) => existing.has(path),
        }),
      ).toEqual(
        new Set([
          'packages/operator-core/lib/goals/spend-rollup.ts',
          'packages/operator-core/lib/goals/spend-rollup.integration.test.ts',
          'apps/operator/lib/release/green-checkpoint.ts',
        ]),
      );
    });

    it('does not reinterpret a package-relative path when invoked from the repository root', () => {
      expect(
        normalizeExplicitFilesForProject({
          files: ['lib/goals/spend-rollup.ts'],
          root: '/repo',
          cwd: '/repo',
          coveredPrefixes,
          pathExists: () => false,
        }),
      ).toEqual(new Set(['lib/goals/spend-rollup.ts']));
    });
  });

  describe('suggestTypecheckGate (discovery, not a hardcoded roster)', () => {
    it("routes a real operator-vite file to that workspace's own typecheck script", () => {
      const s = suggestTypecheckGate(
        REPO_ROOT,
        'apps/operator-vite/src/components/adv/TasksRosterPanel.tsx',
      );
      expect(s).not.toBeNull();
      expect(s!.workspaceDir).toBe('apps/operator-vite');
      expect(s!.standalone).toBe(false);
      expect(s!.command).toBe('npm run --workspace apps/operator-vite typecheck');
    });

    it('routes a STANDALONE package through npm --prefix, never --workspace (WI-10003822)', () => {
      // tools/perf-test/wdio has its own package.json but no root `workspaces` pattern names it.
      // `npm run --workspace tools/perf-test/wdio typecheck` answers "No workspaces found" and
      // exits 1 having checked nothing; this is the file the bug was observed on.
      const s = suggestTypecheckGate(REPO_ROOT, 'tools/perf-test/wdio/perf-report.ts');
      expect(s).not.toBeNull();
      expect(s!.workspaceDir).toBe('tools/perf-test/wdio');
      expect(s!.standalone).toBe(true);
      expect(s!.command).toBe('npm --prefix tools/perf-test/wdio run typecheck');
    });

    it('classifies membership from the root workspaces patterns, both glob and exact forms', () => {
      const root = mkdtempSync(join(tmpdir(), 'tsc-gate-standalone-'));
      try {
        writeFileSync(
          join(root, 'package.json'),
          JSON.stringify({ name: 'mono', private: true, workspaces: ['apps/*', 'libs/listed'] }),
        );
        for (const dir of ['apps/globbed', 'libs/listed', 'tools/solo']) {
          mkdirSync(join(root, dir), { recursive: true });
          writeFileSync(
            join(root, dir, 'package.json'),
            JSON.stringify({ name: dir.replace('/', '-'), scripts: { typecheck: 'tsc --noEmit' } }),
          );
        }
        const globbed = suggestTypecheckGate(root, 'apps/globbed/src/a.ts');
        const listed = suggestTypecheckGate(root, 'libs/listed/src/b.ts');
        const solo = suggestTypecheckGate(root, 'tools/solo/src/c.ts');
        expect(globbed).toMatchObject({ standalone: false, command: 'npm run --workspace apps/globbed typecheck' });
        expect(listed).toMatchObject({ standalone: false, command: 'npm run --workspace libs/listed typecheck' });
        expect(solo).toMatchObject({ standalone: true, command: 'npm --prefix tools/solo run typecheck' });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('finds the NEAREST owning package, not the first ancestor with a package.json', () => {
      const s = suggestTypecheckGate(REPO_ROOT, 'packages/operator-core/lib/lint-tsc.test.ts');
      expect(s!.workspaceDir).toBe('packages/operator-core');
    });

    it('returns null when no owning package.json exists', () => {
      expect(suggestTypecheckGate(REPO_ROOT, 'no-such-dir-xyz/file.ts')).toBeNull();
    });

    it('reports command:null for a workspace with NO typecheck script — a real coverage gap', () => {
      const root = mkdtempSync(join(tmpdir(), 'tsc-gate-'));
      try {
        mkdirSync(join(root, 'apps', 'ungated', 'src'), { recursive: true });
        writeFileSync(
          join(root, 'apps', 'ungated', 'package.json'),
          JSON.stringify({ name: 'ungated', scripts: {} }),
        );
        const s = suggestTypecheckGate(root, 'apps/ungated/src/file.ts');
        expect(s).not.toBeNull();
        expect(s!.workspaceDir).toBe('apps/ungated');
        // No `typecheck` script => nothing local will ever check this file. Say so; do not
        // invent a command that does not exist.
        expect(s!.command).toBeNull();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('never suggests the monorepo ROOT package — `--workspace .` would be noise, not a route', () => {
      // The repo root always has a package.json, so matching it would give every uncovered file
      // a confident, useless suggestion. Walking stops before the root on purpose.
      const root = mkdtempSync(join(tmpdir(), 'tsc-gate-'));
      try {
        writeFileSync(
          join(root, 'package.json'),
          JSON.stringify({ name: 'the-monorepo', scripts: { typecheck: 'tsc' } }),
        );
        expect(suggestTypecheckGate(root, 'sub/file.ts')).toBeNull();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('formatUncoveredFilesBanner', () => {
    const suggestions = new Map([
      [
        'apps/operator-vite/src/b.tsx',
        {
          workspaceDir: 'apps/operator-vite',
          packageName: '@papercusp/operator-vite',
          standalone: false,
          command: 'npm run --workspace apps/operator-vite typecheck',
        },
      ],
    ]);

    it('states plainly that NOTHING was checked when every named file is outside', () => {
      const text = formatUncoveredFilesBanner({
        label: 'operator-core',
        uncovered: ['apps/operator-vite/src/b.tsx'],
        suggestions,
        fatal: true,
      }).join('\n');
      expect(text).toMatch(/NOTHING YOU NAMED WAS TYPECHECKED/);
      // It must hand over the exact next command, not merely diagnose.
      expect(text).toContain('npm run --workspace apps/operator-vite typecheck');
    });

    // EI-21985804122617157 — the header must not contradict the line under it. Both non-routing
    // headers assert the files were NOT typechecked; printing either one directly above
    // "AUTO-ROUTING to check them" tells the reader the opposite of what the gate is doing, and a
    // reader who believes the header stops there.
    it('does not claim the files went unchecked when it is about to route them', () => {
      for (const fatal of [true, false]) {
        const text = formatUncoveredFilesBanner({
          label: 'operator-core',
          uncovered: ['apps/operator-vite/src/b.tsx'],
          suggestions,
          fatal,
          autoRoute: true,
        }).join('\n');
        expect(text).toContain('ROUTING them to the gate that owns them');
        expect(text).not.toMatch(/NOTHING YOU NAMED WAS TYPECHECKED/);
        expect(text).not.toMatch(/were NOT typechecked/);
      }
    });

    it('does not append --files to a workspace typecheck script that invokes raw tsc', () => {
      const file = 'libs/papercusp/libs/db/src/connection.ts';
      const command = 'npm run --workspace libs/papercusp/libs/db typecheck';
      const text = formatUncoveredFilesBanner({
        label: 'operator-core',
        uncovered: [file],
        suggestions: new Map([
          [file, { workspaceDir: 'libs/papercusp/libs/db', packageName: '@papercusp/db-org', standalone: false, command }],
        ]),
        fatal: true,
      }).join('\n');
      expect(text).toContain(`RUN THIS to check them:  ${command}`);
      expect(text).not.toContain(`${command} -- --files=`);
    });

    it('warns but does not claim total failure when SOME files were covered', () => {
      const text = formatUncoveredFilesBanner({
        label: 'operator-core',
        uncovered: ['apps/operator-vite/src/b.tsx'],
        suggestions,
        fatal: false,
      }).join('\n');
      expect(text).not.toMatch(/NOTHING YOU NAMED/);
      expect(text).toMatch(/were NOT typechecked/);
    });

    it('calls out a file no gate covers instead of silently omitting it', () => {
      const text = formatUncoveredFilesBanner({
        label: 'operator-core',
        uncovered: ['apps/thing/src/x.ts'],
        suggestions: new Map([
          ['apps/thing/src/x.ts', { workspaceDir: 'apps/thing', packageName: 'thing', standalone: false, command: null }],
        ]),
        fatal: true,
      }).join('\n');
      expect(text).toMatch(/No typecheck gate FOUND for these/);
      expect(text).toMatch(/apps\/thing/);
      // EI-19461218392796337 — this assertion used to read /NO typecheck gate covers these/,
      // locking in the sentence that continued "nothing local will ever catch a type error
      // here". That is a UNIVERSAL, and the banner has never been able to see enough to make
      // one. It must not come back.
      expect(text).not.toMatch(/nothing local will ever catch/i);
    });

    it('never greenwashes — the same invariant the landing-race caveat carries', () => {
      const text = formatUncoveredFilesBanner({
        label: 'operator-core',
        uncovered: ['apps/operator-vite/src/b.tsx'],
        suggestions,
        fatal: true,
      }).join('\n');
      expect(text).not.toMatch(/safe to ignore|you can ignore|not a real error|disregard|passed/i);
    });
  });

  // EI-19461218392796337 — the banner used to conclude "NO typecheck gate covers these —
  // nothing local will ever catch a type error here" from two facts that do not imply it (the
  // file is outside MY project; its workspace declares no `typecheck` script), never consulting
  // the per-project SIBLING gates. Being covered by a sibling while declaring no workspace
  // script is the NORMAL arrangement here, so it was wrong in the common case.
  //
  // Cost, measured: it argued an agent out of `npm run lint:tsc:operator` — which covers the
  // named file exactly — into hand-grepping a raw 579-error tsc run, where they classified 5
  // type errors they had just introduced into green-checkpoint.test.ts as pre-existing and
  // shipped them. The file it declared uncoverable implements the fleet's release gate.
  describe('sibling-gate resolution (EI-19461218392796337)', () => {
    describe('coveragePrefixesFromGateModule', () => {
      it('derives the prefix from a single-project gate’s exported TSC_COMMAND', () => {
        expect(
          coveragePrefixesFromGateModule({
            TSC_COMMAND: 'npx tsc -p apps/operator/tsconfig.json --noEmit',
          }),
        ).toEqual(['apps/operator/']);
      });

      it('prefers an explicit GATE_COVERAGE list, and accepts a thunk for a discovered set', () => {
        expect(coveragePrefixesFromGateModule({ GATE_COVERAGE: ['libs/papercusp'] })).toEqual([
          'libs/papercusp/',
        ]);
        expect(
          coveragePrefixesFromGateModule({ GATE_COVERAGE: () => ['libs/generic/a/'] }),
        ).toEqual(['libs/generic/a/']);
      });

      it('returns null — UNKNOWN, never "covers nothing" — when a module declares neither', () => {
        // The whole defect being fixed is an absence claimed from a partial view. A module we
        // cannot read must degrade to unknown so the banner can say "none FOUND", not "none
        // exists".
        expect(coveragePrefixesFromGateModule({})).toBeNull();
        expect(coveragePrefixesFromGateModule({ TSC_COMMAND: 'npx tsc --noEmit' })).toBeNull();
      });

      // EI-19462776655300160 — the fan-out gates compute coverage by WALKING THE FILESYSTEM, so
      // a broken tree / permission error raises INSIDE the thunk. This runs on the uncovered-files
      // ERROR path, where an unhandled throw would take down a gate run that was already busy
      // reporting something else.
      it('a THROWING thunk degrades to unknown instead of taking the gate run down', () => {
        const exploding = {
          GATE_COVERAGE: () => {
            throw new Error('EACCES: permission denied');
          },
        };
        expect(() => coveragePrefixesFromGateModule(exploding)).not.toThrow();
        expect(coveragePrefixesFromGateModule(exploding)).toBeNull();
      });

      it('tells the caller a thunk THREW, so the reason cannot misattribute the cause', () => {
        // Both are null, but only one is "the module declares nothing". Reporting a throw as
        // "exports neither GATE_COVERAGE nor a parseable TSC_COMMAND" would be false — it DOES
        // export one — and sends the reader to the wrong file.
        const seen: unknown[] = [];
        coveragePrefixesFromGateModule(
          {
            GATE_COVERAGE: () => {
              throw new Error('boom');
            },
          },
          { onCoverageError: (err: unknown) => seen.push(err) },
        );
        expect(seen).toHaveLength(1);
        expect((seen[0] as Error).message).toBe('boom');

        // The control: a module that genuinely declares nothing must NOT report a coverage error.
        const quiet: unknown[] = [];
        coveragePrefixesFromGateModule({}, { onCoverageError: (err: unknown) => quiet.push(err) });
        expect(quiet).toHaveLength(0);
      });
    });

    describe('gateCoveringFile', () => {
      const gates = [
        { npmScript: 'lint:tsc:papercusp-libs', prefixes: ['libs/papercusp/'] },
        {
          npmScript: 'lint:tsc:orchestrator',
          prefixes: ['libs/papercusp/packages/orchestrator/'],
        },
        { npmScript: 'lint:tsc:operator', prefixes: ['apps/operator/'] },
      ];

      it('routes a file to the gate that covers it', () => {
        expect(gateCoveringFile(gates, 'apps/operator/lib/release/green-checkpoint.ts')).toEqual({
          npmScript: 'lint:tsc:operator',
          prefix: 'apps/operator/',
        });
      });

      it('picks the MOST SPECIFIC gate when several contain the file', () => {
        // The narrower gate is the faster, more attributable answer than the fan-out that also
        // happens to contain it.
        expect(gateCoveringFile(gates, 'libs/papercusp/packages/orchestrator/src/a.ts')!.npmScript)
          .toBe('lint:tsc:orchestrator');
      });

      it('returns null when nothing covers the file — and for an empty roster', () => {
        expect(gateCoveringFile(gates, 'no-such-dir-xyz/file.ts')).toBeNull();
        expect(gateCoveringFile([], 'apps/operator/x.ts')).toBeNull();
      });
    });

    describe('safe auto-routing for fully-covered out-of-project file sets (EI-21310351524853549)', () => {
      it('groups owning workspace routes and keeps unknown files out of an executable plan', () => {
        const suggestions = new Map([
          [
            'apps/operator/scripts/ptool.test.ts',
            {
              workspaceDir: 'apps/operator',
              packageName: '@papercusp/web',
              standalone: false,
              command: 'npm run --workspace apps/operator typecheck',
            },
          ],
          ['unknown/file.ts', null],
        ]);
        const planned = collectAutoTypecheckRoutes({
          files: ['apps/operator/scripts/ptool.test.ts', 'unknown/file.ts'],
          suggestions,
          siblingGates: [],
        });
        expect(planned.routes).toEqual([
          expect.objectContaining({
            workspaceDir: 'apps/operator',
            scoped: false,
            command: 'npm run --workspace apps/operator typecheck',
            args: ['run', '--workspace', 'apps/operator', 'typecheck'],
            files: ['apps/operator/scripts/ptool.test.ts'],
          }),
        ]);
        expect(planned.unknown).toEqual(['unknown/file.ts']);
      });

      it('prefers a verified sibling lint gate and preserves exact file scope', () => {
        const file = 'apps/operator/lib/release/green-checkpoint.ts';
        const planned = collectAutoTypecheckRoutes({
          files: [file],
          // Both routes exist in production. The generic workspace suggestion
          // must not win merely because it was discovered first: it cannot
          // preserve --files and would judge unrelated shared-tree edits.
          suggestions: new Map([[
            file,
            {
              workspaceDir: 'apps/operator',
              packageName: 'web',
              standalone: false,
              command: 'npm run --workspace apps/operator typecheck',
            },
          ]]),
          siblingGates: [{ npmScript: 'lint:tsc:operator', prefixes: ['apps/operator/'] }],
        });
        expect(planned.unknown).toEqual([]);
        expect(planned.routes).toEqual([
          expect.objectContaining({
            command: `npm run lint:tsc:operator -- --files=${file}`,
            args: ['run', 'lint:tsc:operator', '--', `--files=${file}`],
            scoped: true,
          }),
        ]);

        const banner = formatUncoveredFilesBanner({
          label: 'operator-core',
          uncovered: [file],
          suggestions: new Map([[
            file,
            {
              workspaceDir: 'apps/operator',
              packageName: 'web',
              standalone: false,
              command: 'npm run --workspace apps/operator typecheck',
            },
          ]]),
          fatal: true,
          autoRoute: true,
          siblingGates: [{ npmScript: 'lint:tsc:operator', prefixes: ['apps/operator/'] }],
        }).join('\n');
        expect(banner).toContain(`npm run lint:tsc:operator -- --files=${file}`);
        expect(banner).not.toContain('npm run --workspace apps/operator typecheck');
      });

      it('executes each validated route without a shell and returns the first child failure', () => {
        const invocations: { file: string; args: string[]; options: Record<string, unknown> }[] = [];
        const planned = collectAutoTypecheckRoutes({
          files: ['apps/operator/scripts/ptool.test.ts'],
          suggestions: new Map([
            [
              'apps/operator/scripts/ptool.test.ts',
              { workspaceDir: 'apps/operator', packageName: 'web', standalone: false, command: 'npm run --workspace apps/operator typecheck' },
            ],
          ]),
        });
        const exit = runAutoTypecheckRoutes({
          root: '/repo',
          routes: planned.routes,
          execFile: (file: string, args: string[], options: Record<string, unknown>) => {
            invocations.push({ file, args, options });
            const error = Object.assign(new Error('child failed'), { status: 7 });
            throw error;
          },
        });
        expect(exit).toBe(7);
        expect(invocations).toHaveLength(1);
        expect(invocations[0]).toMatchObject({
          file: 'npm',
          args: ['run', '--workspace', 'apps/operator', 'typecheck'],
          options: { cwd: '/repo', stdio: 'inherit' },
        });
        expect((invocations[0].options.env as Record<string, string>).PAPERCUSP_TSC_AUTO_ROUTE).toBe('1');
      });

      it('an OUT-OF-SCOPE delegate is unchecked files only when the mixed branch opts in (WI-6554700010009876)', () => {
        const routes = [{ args: ['run', '--workspace', 'pkg-b', 'typecheck'] }];
        const childExit = (marker: string) => (): never => {
          throw Object.assign(new Error('child exit 1'), { status: 1, stdout: `${marker}\n` });
        };
        const outOfScope = childExit('LINT_TSC_RESULT label=fixture-delegate scope=files exit=1 status=out-of-scope filesUnchecked=2');
        const unchecked: number[] = [];
        // Mixed branch: the caller still owes its own compile, so a gap must not short-circuit it.
        expect(
          runAutoTypecheckRoutes({ root: '/repo', routes, execFile: outOfScope, onUnchecked: (n: number) => unchecked.push(n), outOfScopeIsUnchecked: true }),
        ).toBe(0);
        expect(unchecked).toEqual([2]);
        // All-routed branch (no opt-in): nothing else will compile, so exit 0 would claim a check that never ran.
        expect(runAutoTypecheckRoutes({ root: '/repo', routes, execFile: outOfScope, onUnchecked: () => {} })).toBe(1);
        // A delegate that really failed stays a failure even with the opt-in.
        const regressed = childExit('LINT_TSC_RESULT label=fixture-delegate scope=files exit=1 status=regressed');
        expect(
          runAutoTypecheckRoutes({ root: '/repo', routes, execFile: regressed, onUnchecked: () => {}, outOfScopeIsUnchecked: true }),
        ).toBe(1);
        // Only the delegate's FINAL marker counts: a nested child's out-of-scope line does not excuse its parent's red.
        const nested = (): never => {
          throw Object.assign(new Error('child exit 1'), {
            status: 1,
            stdout: 'LINT_TSC_RESULT label=inner scope=files exit=1 status=out-of-scope filesUnchecked=1\nLINT_TSC_RESULT label=outer scope=files exit=1 status=regressed\n',
          });
        };
        expect(
          runAutoTypecheckRoutes({ root: '/repo', routes, execFile: nested, onUnchecked: () => {}, outOfScopeIsUnchecked: true }),
        ).toBe(1);
      });

      it('plans a standalone package as npm --prefix and a workspace package as npm run --workspace (WI-10003822)', () => {
        expect(workspaceTypecheckArgs('tools/solo', true)).toEqual(['--prefix', 'tools/solo', 'run', 'typecheck']);
        expect(workspaceTypecheckArgs('apps/operator', false)).toEqual(['run', '--workspace', 'apps/operator', 'typecheck']);
        const planned = collectAutoTypecheckRoutes({
          files: ['tools/solo/a.ts', 'apps/operator/b.ts'],
          suggestions: new Map([
            [
              'tools/solo/a.ts',
              { workspaceDir: 'tools/solo', packageName: 'solo', standalone: true, command: 'npm --prefix tools/solo run typecheck' },
            ],
            [
              'apps/operator/b.ts',
              { workspaceDir: 'apps/operator', packageName: 'web', standalone: false, command: 'npm run --workspace apps/operator typecheck' },
            ],
          ]),
        });
        expect(planned.unknown).toEqual([]);
        expect(planned.routes).toEqual([
          expect.objectContaining({
            workspaceDir: 'tools/solo',
            command: 'npm --prefix tools/solo run typecheck',
            args: ['--prefix', 'tools/solo', 'run', 'typecheck'],
          }),
          expect.objectContaining({
            workspaceDir: 'apps/operator',
            command: 'npm run --workspace apps/operator typecheck',
            args: ['run', '--workspace', 'apps/operator', 'typecheck'],
          }),
        ]);
      });

      it('a planned standalone route really runs the package script under npm; the old --workspace argv does not (WI-10003822)', () => {
        const root = mkdtempSync(join(tmpdir(), 'tsc-gate-standalone-npm-'));
        try {
          writeFileSync(
            join(root, 'package.json'),
            JSON.stringify({ name: 'mono', private: true, workspaces: ['apps/*'] }),
          );
          mkdirSync(join(root, 'tools', 'solo'), { recursive: true });
          writeFileSync(
            join(root, 'tools', 'solo', 'package.json'),
            JSON.stringify({
              name: 'solo',
              private: true,
              scripts: { typecheck: `node -e "require('fs').writeFileSync('ran.txt','ok')"` },
            }),
          );
          const file = 'tools/solo/src/a.ts';
          const planned = collectAutoTypecheckRoutes({
            files: [file],
            suggestions: new Map([[file, suggestTypecheckGate(root, file)]]),
          });
          expect(planned.routes.map((r: { args: string[] }) => r.args)).toEqual([
            ['--prefix', 'tools/solo', 'run', 'typecheck'],
          ]);
          const quiet = (cmd: string, args: string[], options: Record<string, unknown>) =>
            execFileSync(cmd, args, { ...options, stdio: 'pipe' });

          expect(runAutoTypecheckRoutes({ root, routes: planned.routes, execFile: quiet })).toBe(0);
          expect(readFileSync(join(root, 'tools', 'solo', 'ran.txt'), 'utf8')).toBe('ok');

          // Control: the argv this route used to emit fails for the same package, so the
          // assertions above would have caught the bug rather than passing vacuously.
          rmSync(join(root, 'tools', 'solo', 'ran.txt'));
          const oldArgs = ['run', '--workspace', 'tools/solo', 'typecheck'];
          expect(runAutoTypecheckRoutes({ root, routes: [{ args: oldArgs }], execFile: quiet })).not.toBe(0);
          expect(existsSync(join(root, 'tools', 'solo', 'ran.txt'))).toBe(false);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    });

    describe('discoverSiblingTypecheckGates (against the REAL repo)', () => {
      it('finds the gate that actually covers apps/operator — the file this bug was filed over', () => {
        // Deliberately measured against the real root package.json rather than a fixture: the
        // false claim was about THIS repo's real arrangement, and a fixture could not have
        // caught it.
        return discoverSiblingTypecheckGates(REPO_ROOT).then((res) => {
          expect(res.rosterReadable).toBe(true);
          const covering = gateCoveringFile(
            res.gates,
            'apps/operator/lib/release/green-checkpoint.ts',
          );
          expect(covering).not.toBeNull();
          expect(covering!.npmScript).toBe('lint:tsc:operator');
        });
      });

      it('reports a gate it could NOT resolve with a reason instead of dropping it silently', () => {
        // A gate whose coverage cannot be determined is the input that makes an absence claim
        // unsafe. It must arrive as evidence, not as silence.
        return discoverSiblingTypecheckGates(REPO_ROOT).then((res) => {
          for (const u of res.unresolved) {
            expect(u.npmScript).toMatch(/^lint:tsc/);
            expect(u.reason.length).toBeGreaterThan(0);
          }
          // Every discovered gate carries at least one usable prefix.
          for (const g of res.gates) expect(g.prefixes.length).toBeGreaterThan(0);
        });
      });

      // EI-19462776655300160 — the ratchet. Every `lint:tsc*` gate now declares its coverage, so
      // the banner never has to append its "the search was INCOMPLETE" caveat for real repo paths.
      // A NEW gate that declares neither re-arms that caveat on every ungated message repo-wide,
      // which is why this is asserted rather than left to drift back.
      it('resolves EVERY lint:tsc* gate in the real repo — no gate lacks a coverage declaration', () => {
        return discoverSiblingTypecheckGates(REPO_ROOT).then((res) => {
          expect(res.rosterReadable).toBe(true);
          expect(
            res.unresolved,
            'A lint:tsc* gate declares neither GATE_COVERAGE nor a parseable TSC_COMMAND, so the ' +
              'uncovered-files banner must now caveat EVERY "no gate found" message repo-wide. Fix ' +
              'by exporting one from the gate module named below: a single-project gate exports ' +
              '`TSC_COMMAND`; a FAN-OUT gate exports `GATE_COVERAGE` as a thunk delegating to its ' +
              'own selectGatedPackages() (see scripts/lint-tsc-workspaces.mjs).',
          ).toEqual([]);
        });
      });

      // The fan-outs are the two this item added, and they are the ones whose coverage is
      // DISCOVERED rather than written down — so they are the ones that can silently go to zero.
      it('the two FAN-OUT gates each resolve to a non-trivial discovered set', () => {
        return discoverSiblingTypecheckGates(REPO_ROOT).then((res) => {
          for (const npmScript of ['lint:tsc:workspaces', 'lint:tsc:papercusp-libs']) {
            const gate = res.gates.find((g) => g.npmScript === npmScript);
            expect(gate, `${npmScript} did not resolve`).toBeDefined();
            // A fan-out that discovers nothing has silently stopped covering anything — the exact
            // vacuous-green shape both scripts refuse at run time.
            expect(gate!.prefixes.length).toBeGreaterThan(1);
            for (const p of gate!.prefixes) expect(p.endsWith('/')).toBe(true);
          }
        });
      });

      it('routes a libs/generic file to the workspaces fan-out — the routing this item restored', () => {
        // Before EI-19462776655300160 this file got "no gate FOUND" plus an incompleteness
        // caveat, despite lint:tsc:workspaces gating it.
        return discoverSiblingTypecheckGates(REPO_ROOT).then((res) => {
          const covering = gateCoveringFile(res.gates, 'libs/generic/rerank/src/index.ts');
          expect(covering).not.toBeNull();
          expect(covering!.npmScript).toBe('lint:tsc:workspaces');
        });
      });

      it('reports rosterReadable:false when the roster itself cannot be read', () => {
        const root = mkdtempSync(join(tmpdir(), 'tsc-gate-roster-'));
        try {
          return discoverSiblingTypecheckGates(root).then((res) => {
            expect(res.rosterReadable).toBe(false);
            expect(res.gates).toEqual([]);
          });
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    });

    describe('formatUncoveredFilesBanner routes to the sibling gate', () => {
      const OPERATOR_FILE = 'apps/operator/lib/release/green-checkpoint.ts';
      // apps/operator declares no `typecheck` script — which is precisely why the old code
      // called it permanently uncheckable.
      const noWorkspaceScript = new Map([
        [OPERATOR_FILE, { workspaceDir: 'apps/operator', packageName: 'operator', standalone: false, command: null }],
      ]);
      const siblingGates = [{ npmScript: 'lint:tsc:operator', prefixes: ['apps/operator/'] }];

      it('hands over the sibling command instead of declaring the file uncoverable', () => {
        const text = formatUncoveredFilesBanner({
          label: 'operator-vite',
          uncovered: [OPERATOR_FILE],
          suggestions: noWorkspaceScript,
          fatal: true,
          siblingGates,
          unresolvedGates: [],
        }).join('\n');
        expect(text).toContain('npm run lint:tsc:operator -- --files=apps/operator/lib/release/green-checkpoint.ts');
        expect(text).not.toMatch(/nothing local will ever catch/i);
        expect(text).not.toMatch(/No typecheck gate FOUND/);
      });

      it('CONTROL: the identical call with an empty gate roster does NOT route — so the pass above is the resolution working, not the wording', () => {
        // Without this control the assertion above would still pass if the banner simply never
        // emitted the ungated branch for any input.
        const text = formatUncoveredFilesBanner({
          label: 'operator-vite',
          uncovered: [OPERATOR_FILE],
          suggestions: noWorkspaceScript,
          fatal: true,
          siblingGates: [],
          unresolvedGates: [],
        }).join('\n');
        expect(text).not.toContain('npm run lint:tsc:operator');
        expect(text).toMatch(/No typecheck gate FOUND/);
      });

      it('says "none FOUND, not none exists" and names what it could not resolve', () => {
        const text = formatUncoveredFilesBanner({
          label: 'operator-core',
          uncovered: ['no-such-dir-xyz/file.ts'],
          suggestions: new Map(),
          fatal: true,
          siblingGates,
          unresolvedGates: [{ npmScript: 'lint:tsc:workspaces', reason: 'exports no coverage' }],
        }).join('\n');
        expect(text).toMatch(/search was INCOMPLETE/);
        expect(text).toMatch(/"none found", NOT "none exists"/);
        expect(text).toContain('lint:tsc:workspaces');
        expect(text).toContain('exports no coverage');
      });

      it('claims a COMPLETE search only when every gate resolved', () => {
        const text = formatUncoveredFilesBanner({
          label: 'operator-core',
          uncovered: ['no-such-dir-xyz/file.ts'],
          suggestions: new Map(),
          fatal: true,
          siblingGates,
          unresolvedGates: [],
        }).join('\n');
        expect(text).toMatch(/Searched: every/);
        expect(text).not.toMatch(/search was INCOMPLETE/);
        // Still never a universal, even with a complete search: "no gate found" is the honest
        // ceiling, because coverage is read from what each gate DECLARES.
        expect(text).not.toMatch(/nothing local will ever catch/i);
      });

      it('an unreadable roster is treated as blind, not as a complete search', () => {
        const text = formatUncoveredFilesBanner({
          label: 'operator-core',
          uncovered: ['no-such-dir-xyz/file.ts'],
          suggestions: new Map(),
          fatal: true,
          siblingGates: [],
          unresolvedGates: [],
          rosterReadable: false,
        }).join('\n');
        expect(text).toMatch(/search was INCOMPLETE/);
        expect(text).toMatch(/no gate roster available/);
      });
    });
  });

  // The watermark that lets concurrent gate runs share ONE compile (EI-19340233074452707).
  //
  // A full compile that started at S read the tree as of S, so its diagnostics are a true
  // answer about file F iff mtime(F) < S. Passing max(mtime) over the files this run was
  // asked about lets pc-heavy drop its whole-tree token — which on this repo moves ~every
  // 18s against a ~170s compile, so no two callers ever shared a key and each paid a full
  // compile (3-5 byte-identical operator-core compiles observed live on 2026-08-02).
  describe('coalesceWatermarkFor — freshness watermark for compile sharing', () => {
    let dir = '';
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = '';
    });
    const mk = (rel: string, mtimeMs?: number) => {
      const p = join(dir, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, 'x');
      if (mtimeMs !== undefined) utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
      return rel;
    };

    it('returns the NEWEST mtime across the named files, rounded past its whole second', () => {
      dir = mkdtempSync(join(tmpdir(), 'cwm-'));
      const older = 1_700_000_000_000;
      const newer = 1_700_000_500_000;
      mk('a.ts', older);
      mk('b.ts', newer);
      const got = coalesceWatermarkFor({ root: dir, files: new Set(['a.ts', 'b.ts']), updateFlag: false });
      expect(got).toBe(Math.floor(newer / 1000) + 1);
    });

    it('rounds UP so a sub-second edit can never tie with an earlier compile start', () => {
      // The hazard this guards: a file written at t.900 floors to t, and a compile that
      // began at t.100 — BEFORE the edit — also stamps t. Comparing equal would replay a
      // pre-edit answer as fresh, which is the exact bug the barrier exists to prevent.
      dir = mkdtempSync(join(tmpdir(), 'cwm-'));
      const t = 1_700_000_000;
      mk('a.ts', t * 1000 + 900);
      expect(coalesceWatermarkFor({ root: dir, files: new Set(['a.ts']), updateFlag: false })).toBe(t + 1);
    });

    it('opts out (null) for an UNSCOPED run — a bare CI gate judges every file', () => {
      dir = mkdtempSync(join(tmpdir(), 'cwm-'));
      expect(coalesceWatermarkFor({ root: dir, files: null, updateFlag: false })).toBeNull();
      expect(coalesceWatermarkFor({ root: dir, files: new Set(), updateFlag: false })).toBeNull();
    });

    it('opts out (null) under --update — a run that WRITES the baseline must measure it itself', () => {
      // Ratcheting off a replayed compile would persist a count nobody re-measured from
      // this tree state, and a too-low baseline is the EI-487 / WI-4488 failure mode.
      dir = mkdtempSync(join(tmpdir(), 'cwm-'));
      mk('a.ts');
      expect(coalesceWatermarkFor({ root: dir, files: new Set(['a.ts']), updateFlag: true })).toBeNull();
    });

    it('fails CLOSED on a file it cannot stat, rather than computing a partial watermark', () => {
      dir = mkdtempSync(join(tmpdir(), 'cwm-'));
      mk('a.ts');
      // A named file that is missing is not evidence that nothing changed — giving back a
      // watermark derived from only the files we could see would admit replays the caller
      // never vouched for.
      expect(
        coalesceWatermarkFor({ root: dir, files: new Set(['a.ts', 'gone.ts']), updateFlag: false }),
      ).toBeNull();
    });

    // EI-19483243844876537: a checked file's own mtime says nothing about a GENERATED
    // `.d.mts` a different, already-tracked `.mjs` exports through — tsc resolves an
    // importer's types via the companion declaration, not the source, so a checked file
    // can go from red to green (or vice versa) purely because `gen:declarations` ran,
    // with the checked file's own mtime untouched. Repro: added exports to a `.mjs`,
    // regenerated declarations, then `lint:tsc --files=<tests using the new export>`
    // replayed a pre-regen cached compile reporting TS2305 for exports that provably
    // existed on disk.
    it('folds in the newest DECLARATION mtime, not just the named files (EI-19483243844876537)', () => {
      dir = mkdtempSync(join(tmpdir(), 'cwm-'));
      const fileTouched = 1_700_000_000_000;
      const declTouchedLater = 1_700_000_900_000; // gen:declarations ran AFTER the checked file was saved
      mk('a.test.ts', fileTouched);
      writeFileSync(
        join(dir, 'tsconfig.declarations.json'),
        JSON.stringify({ files: ['scripts/foo.mjs'] }),
      );
      mk('scripts/foo.d.mts', declTouchedLater);

      const got = coalesceWatermarkFor({ root: dir, files: new Set(['a.test.ts']), updateFlag: false });
      // Watermark must reflect the LATER declaration write, not the (earlier) checked file —
      // otherwise a cached compile from between the two is wrongly accepted as fresh.
      expect(got).toBe(Math.floor(declTouchedLater / 1000) + 1);
      expect(got).not.toBe(Math.floor(fileTouched / 1000) + 1);
    });

    it('is unaffected by declarations OLDER than the named files (no spurious widening)', () => {
      dir = mkdtempSync(join(tmpdir(), 'cwm-'));
      const declTouched = 1_700_000_000_000;
      const fileTouchedLater = 1_700_000_900_000;
      writeFileSync(
        join(dir, 'tsconfig.declarations.json'),
        JSON.stringify({ files: ['scripts/foo.mjs'] }),
      );
      mk('scripts/foo.d.mts', declTouched);
      mk('a.test.ts', fileTouchedLater);

      const got = coalesceWatermarkFor({ root: dir, files: new Set(['a.test.ts']), updateFlag: false });
      expect(got).toBe(Math.floor(fileTouchedLater / 1000) + 1);
    });

    it('an UNREADABLE/missing declaration is skipped, not treated as failure (fails open, unlike named files)', () => {
      dir = mkdtempSync(join(tmpdir(), 'cwm-'));
      mk('a.test.ts', 1_700_000_000_000);
      // tsconfig.declarations.json names a file that was never actually generated —
      // must not make the whole watermark computation bail out (contrast the "fails
      // CLOSED on a file it cannot stat" test above, which is about a NAMED file).
      writeFileSync(
        join(dir, 'tsconfig.declarations.json'),
        JSON.stringify({ files: ['scripts/never-generated.mjs'] }),
      );
      expect(
        coalesceWatermarkFor({ root: dir, files: new Set(['a.test.ts']), updateFlag: false }),
      ).toBe(Math.floor(1_700_000_000_000 / 1000) + 1);
    });

    it('no tsconfig.declarations.json at all — unaffected (matches every pre-existing test above)', () => {
      dir = mkdtempSync(join(tmpdir(), 'cwm-'));
      mk('a.test.ts', 1_700_000_000_000);
      expect(
        coalesceWatermarkFor({ root: dir, files: new Set(['a.test.ts']), updateFlag: false }),
      ).toBe(Math.floor(1_700_000_000_000 / 1000) + 1);
    });
  });

  describe('pcHeavyCompileArgv — stable typecheck admission without per-file coalescing drift', () => {
    it('marks an unscoped compile with the stable lint:tsc sentinel', () => {
      expect(pcHeavyCompileArgv('npx tsc -p tsconfig.json', false)).toEqual([
        'sh',
        '-c',
        'npx tsc -p tsconfig.json 2>&1',
        'lint:tsc',
      ]);
    });

    it('adds stable lint:tsc and --files sentinels for pc-heavy while leaving the shell command unchanged', () => {
      const argv = pcHeavyCompileArgv("printf 'compile-ok'", true);
      expect(argv).toEqual([
        'sh',
        '-c',
        "printf 'compile-ok' 2>&1",
        'lint:tsc',
        '--files=__pc_heavy_scoped__',
      ]);
      expect(execFileSync(argv[0], argv.slice(1), { encoding: 'utf8' })).toBe('compile-ok');
    });
  });

  describe('declarationFilesFromConfig — the `.d.mts` companions gen:declarations writes', () => {
    let dir = '';
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = '';
    });

    it('maps each declared .mjs to its co-located .d.mts', () => {
      dir = mkdtempSync(join(tmpdir(), 'dfc-'));
      writeFileSync(
        join(dir, 'tsconfig.declarations.json'),
        JSON.stringify({ files: ['scripts/foo.mjs', 'scripts/nested/bar.mjs'] }),
      );
      expect(declarationFilesFromConfig(dir)).toEqual([
        'scripts/foo.d.mts',
        'scripts/nested/bar.d.mts',
      ]);
    });

    it('tolerates JSONC `//` comments, same as gen-declarations.ts\'s own parser', () => {
      dir = mkdtempSync(join(tmpdir(), 'dfc-'));
      writeFileSync(
        join(dir, 'tsconfig.declarations.json'),
        '// a leading comment\n' + JSON.stringify({ files: ['scripts/foo.mjs'] }),
      );
      expect(declarationFilesFromConfig(dir)).toEqual(['scripts/foo.d.mts']);
    });

    it('fails OPEN (empty array) when the config is missing or malformed — a signal, not a hard dependency', () => {
      dir = mkdtempSync(join(tmpdir(), 'dfc-'));
      expect(declarationFilesFromConfig(dir)).toEqual([]); // no file at all
      writeFileSync(join(dir, 'tsconfig.declarations.json'), '{ not valid json');
      expect(declarationFilesFromConfig(dir)).toEqual([]);
    });

    it('against the REAL repo config: every entry exists on disk (sanity check on the fixture assumption)', () => {
      const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
      const rels = declarationFilesFromConfig(root);
      expect(rels.length).toBeGreaterThan(0);
      for (const rel of rels) {
        expect(existsSync(join(root, rel))).toBe(true);
      }
    });
  });
});

// EI-21985804122617157 — a MIXED `--files` set must ROUTE its out-of-project files, not skip them.
//
// The report that opened this said `lint:tsc` gives an apps/operator edit "NO typecheck at all".
// Measurement refuted that: auto-routing already existed, and a set lying ENTIRELY outside
// operator-core has run the owning gate since EI-19461218392796337. The real hole was one
// condition narrower than the report claimed — `canAutoRoute` required `fatal`, so naming files in
// TWO packages (the shape this gate's own comments call "the common, legitimate 'check my edit
// across two packages' run") took the partial branch and exited 0 with the out-of-project files
// never compiled. Measured on the real repo BEFORE the fix:
//   --files=<one operator-core file>,<one apps/operator file>
//   -> LINT_TSC_RESULT ... exit=0 status=partial filesUnchecked=1
describe('EI-21985804122617157 - mixed --files sets delegate instead of silently skipping', () => {
  describe('the marker discloses delegation WITHOUT claiming the routed vocabulary', () => {
    // The load-bearing distinction. `routed`/`routed-failed` mean "this gate had no verdict of its
    // own and handed the whole request over". A partial run keeps its OWN verdict, so stamping it
    // `routed` would make a genuine operator-core regression print `routed-failed` and read as
    // somebody else's failure.
    it('keeps status=clean and appends filesRoutedAway when a delegate covered the remainder', () => {
      expect(
        formatLintTscResultMarker({
          label: 'operator-core',
          scope: 'files',
          code: 0,
          filesUnchecked: 0,
          filesRoutedAway: 1,
        }),
      ).toBe('LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean filesRoutedAway=1');
    });

    it('a REGRESSION in this gate still reads regressed - never routed-failed - when files were routed', () => {
      const marker = formatLintTscResultMarker({
        label: 'operator-core',
        scope: 'files',
        code: 1,
        filesRoutedAway: 2,
      });
      expect(marker).toContain('status=regressed');
      expect(marker).not.toContain('routed-failed');
      expect(marker).toContain('filesRoutedAway=2');
    });

    // Both fields can legitimately co-occur: some uncovered files had a known owner and were
    // routed, others had none and genuinely went unchecked. Suppressing either is a false claim.
    it('reports filesUnchecked and filesRoutedAway together, in that order', () => {
      expect(
        formatLintTscResultMarker({
          label: 'operator-core',
          scope: 'files',
          code: 0,
          filesUnchecked: 2,
          filesRoutedAway: 1,
        }),
      ).toBe(
        'LINT_TSC_RESULT label=operator-core scope=files exit=0 status=partial filesUnchecked=2 filesRoutedAway=1',
      );
    });

    // Additive-only: a run that routed nothing must be byte-identical to before this change, or
    // every existing consumer assertion in this file is silently measuring new behaviour.
    it('is byte-identical to the pre-change marker when nothing was routed', () => {
      for (const filesRoutedAway of [0, undefined]) {
        expect(
          formatLintTscResultMarker({
            label: 'operator-core',
            scope: 'files',
            code: 0,
            filesRoutedAway,
          }),
        ).toBe('LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean');
      }
    });
  });

  // WHY A SUBPROCESS AND A REAL WORKSPACE. The formatter tests above cannot fail if the partial
  // branch never CALLS the router - which is precisely the bug that was here. `runAutoTypecheckRoutes`
  // is not injectable from `runTscBaselineGate`, so the delegate has to be a real `npm run` against a
  // real workspace. Its `typecheck` script prints a sentinel, so "the delegate actually executed" is
  // proven by output rather than inferred from an exit code a no-op would produce too.
  describe('the WIRING: the partial branch really runs the owning gate', () => {
    const GATE_URL = pathToFileURL(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        'scripts',
        'lib',
        'tsc-baseline-gate.mjs',
      ),
    ).href;

    /**
     * A fixture repo with TWO workspaces: `pkg-a` is the gate's own project, `pkg-b` is outside it
     * but declares a `typecheck` script, which is what makes it routable.
     *
     * The `# -p pkg-a/tsconfig.json` suffix on tscCommand is load-bearing: `projectPrefixFromTscCommand`
     * scans the command STRING for `-p <path>`, while the shell treats the `#` as a comment and still
     * just cats the canned diagnostics. Without a resolvable project prefix the coverage branch is
     * skipped entirely, and this test would pass against code that never routes anything.
     */
    function runMixedGate(
      delegateScript: string,
      env: Record<string, string> = {},
      files = ['pkg-a/lib/a.ts', 'pkg-b/lib/b.ts'],
    ): { out: string; code: number } {
      const root = mkdtempSync(join(tmpdir(), 'tsc-gate-mixed-route-'));
      try {
        mkdirSync(join(root, 'pkg-a', 'lib'), { recursive: true });
        mkdirSync(join(root, 'pkg-b', 'lib'), { recursive: true });
        writeFileSync(join(root, 'pkg-a', 'lib', 'a.ts'), 'export const fixture = 1;\n');
        writeFileSync(join(root, 'pkg-b', 'lib', 'b.ts'), 'export const fixture = 1;\n');
        writeFileSync(join(root, 'pkg-a', 'tsconfig.json'), '{}');
        writeFileSync(
          join(root, 'package.json'),
          JSON.stringify({ name: 'fixture-root', private: true, workspaces: ['pkg-b'] }),
        );
        writeFileSync(
          join(root, 'pkg-b', 'package.json'),
          JSON.stringify({
            name: 'pkg-b',
            version: '0.0.0',
            scripts: { typecheck: delegateScript },
          }),
        );
        // Two diagnostics for the COVERED file, matched exactly by the baseline below, so this
        // gate's own verdict is a true `clean` and the assertion is about routing alone.
        writeFileSync(
          join(root, 'tsc-output.txt'),
          "pkg-a/lib/a.ts(10,3): error TS2322: Type 'string' is not assignable to type 'number'.\n" +
            'pkg-a/lib/a.ts(11,3): error TS2339: Property x does not exist.\n',
        );
        writeFileSync(join(root, 'baseline.json'), JSON.stringify({ files: { 'pkg-a/lib/a.ts': 2 } }));
        writeFileSync(
          join(root, 'run.mjs'),
          `import { runTscBaselineGate } from ${JSON.stringify(GATE_URL)};\n` +
            `await runTscBaselineGate({\n` +
            `  root: ${JSON.stringify(root)},\n` +
            `  tscCommand: ${JSON.stringify(`cat ${join(root, 'tsc-output.txt')} # -p pkg-a/tsconfig.json`)},\n` +
            `  baselineFile: ${JSON.stringify(join(root, 'baseline.json'))},\n` +
            `  label: 'test',\n` +
            `  argv: [${JSON.stringify(`--files=${files.join(',')}`)}],\n` +
            `});\n`,
        );
        try {
          const out = execFileSync('node', [join(root, 'run.mjs')], {
            encoding: 'utf-8',
            stdio: 'pipe',
            cwd: root,
            env: { ...process.env, ...env },
          });
          return { out, code: 0 };
        } catch (e: any) {
          return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? -1 };
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    it('executes the owning gate for the out-of-project file and reports filesRoutedAway, not partial', () => {
      const { out, code } = runMixedGate('node -e "console.log(\'DELEGATE-RAN\')"');
      // The delegate genuinely executed - not merely named in a banner, which is what the
      // pre-fix behaviour did and what let the gap survive.
      expect(out).toContain('DELEGATE-RAN');
      expect(out).toContain('filesRoutedAway=1');
      // The whole point: the file is no longer reported as never-compiled.
      expect(out).not.toContain('status=partial');
      expect(out).not.toContain('filesUnchecked=1');
      expect(code).toBe(0);
    });

    // Exit 1 is what a real sibling gate returns on a regression (every `lint:tsc*` leg does),
    // so this is the delegate-failure shape that actually occurs.
    it('a FAILING delegate fails the run and reads routed-failed, carrying the child exit code', () => {
      const { out, code } = runMixedGate('node -e "process.exit(1)"');
      expect(code).toBe(1);
      expect(out).toContain('status=routed-failed');
      // It must NOT read `regressed`: this gate's own compile never ran, so blaming
      // operator-core would point the caller at a file that was never judged.
      expect(out).not.toContain('status=regressed');
    });

    // WI-6554700010009876: a delegate that compiled NONE of its files also exits 1, but its own
    // marker says status=out-of-scope. That is a coverage gap, not a type error, so this gate's
    // own compile must still run and the run reads partial, never routed-failed.
    it('an OUT-OF-SCOPE delegate does not short-circuit the own compile: partial, never routed-failed', () => {
      const { out, code } = runMixedGate(
        'node -e "console.log(\'LINT_TSC_RESULT label=fixture-delegate scope=files exit=1 status=out-of-scope filesUnchecked=1\'); process.exit(1)"',
      );
      expect(out).toContain('label=fixture-delegate');
      expect(out).not.toContain('status=routed-failed');
      // THIS gate's own marker: its covered file was compiled and the routed file is reported unchecked.
      expect(out).toMatch(/LINT_TSC_RESULT label=test scope=files exit=0 status=partial\b[^\n]*filesUnchecked=1\b/);
      expect(code).toBe(0);
    });

    // THE FALSIFIABILITY CONTROL, and a real guard in its own right.
    //
    // A guard test that has never failed is a guard you have not tested — but this repo forbids
    // proving that by mutating the shared tree (git-sync commits the whole working tree on a
    // schedule, so a probe that holds a mutant for the length of a run can have it committed even
    // when nothing goes wrong). `PAPERCUSP_TSC_AUTO_ROUTE=1` is the gate's OWN recursion kill
    // switch, and disabling routing is EXACTLY the pre-fix behaviour of the partial branch — so
    // the same fixture, one env var apart, reproduces the bug this section fixes with no mutation
    // at all. If the two tests above ever start passing for the wrong reason, this one still
    // pins what the old code did, and it fails if the kill switch stops working.
    it('CONTROL: with routing disabled the same fixture reproduces the pre-fix partial + unchecked file', () => {
      const { out, code } = runMixedGate('node -e "console.log(\'DELEGATE-RAN\')"', {
        PAPERCUSP_TSC_AUTO_ROUTE: '1',
      });
      expect(out).not.toContain('DELEGATE-RAN'); // the delegate never ran
      expect(out).toContain('status=partial');
      expect(out).toContain('filesUnchecked=1');
      expect(out).not.toContain('filesRoutedAway=');
      // The defect in one line: a file the caller named was never compiled, and the run passed.
      expect(code).toBe(0);
    });

    // An ABNORMAL delegate code (a crash, an OOM, a SIGTERM'd child) is deliberately NOT
    // laundered into the lint vocabulary. `routed-failed` is a verdict — "the owning gate judged
    // your file and it is red" — and a code the gate does not recognise has not earned it. The
    // code is preserved verbatim so the caller can tell a crash from a type error.
    it('preserves an abnormal delegate exit code as error(N) rather than calling it a verdict', () => {
      const { out, code } = runMixedGate('node -e "process.exit(3)"');
      expect(code).toBe(3);
      expect(out).toContain('status=error(3)');
      expect(out).not.toContain('routed-failed');
    });

    it.each([['mixed', undefined], ['entirely delegated', ['pkg-b/lib/b.ts']]])(
      'preserves a successful partial delegate in the %s parent verdict', (_kind, files) => {
        const { out, code } = runMixedGate(
          'node -e "console.log(\'LINT_TSC_RESULT label=delegate scope=files exit=0 status=partial filesUnchecked=1\')"',
          {}, files,
        );
        expect(code).toBe(0);
        const parent = out.split('\n').filter((line) => line.startsWith('LINT_TSC_RESULT label=test ')).at(-1);
        expect(parent).toContain('status=partial filesUnchecked=1');
        expect(parent).not.toContain('status=clean');
        expect(parent).not.toContain('filesRoutedAway=1');
      },
    );
  });
});

describe('actual program coverage of scoped typechecks (EI-25574814068391872)', () => {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const gateUrl = pathToFileURL(join(repoRoot, 'scripts/lib/tsc-baseline-gate.mjs')).href;
  const exec = promisify(execFile);
  const unitTestTimeoutMs = Number(process.env.VITEST_UNIT_TIMEOUT_MS) || DEFAULT_UNIT_TEST_TIMEOUT_MS;
  const childFinalizationHeadroomMs = 5_000;

  async function runCoverageGate(files: string[], service: boolean) {
    const root = mkdtempSync(join(tmpdir(), 'tsc-gate-enrollment-'));
    const server = service ? createServer((socket) => {
      socket.once('data', () => {
        const checked: string[] = files.filter((file) => file === 'scripts/included.ts');
        socket.end(JSON.stringify({
          ok: true, output: '', errorCount: 0, checked,
          counts: { named: checked.length, typeReferencing: 0, importers: 0 },
          namedNotInProgram: files.filter((file) => !checked.includes(file)),
          snapshotAgeMs: 0, queuedMs: 0, checkMs: 0,
        }) + '\n');
      });
    }) : null;
    try {
      mkdirSync(join(root, 'scripts'));
      symlinkSync(join(repoRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
      writeFileSync(join(root, 'scripts/included.ts'), 'export const fixture: number = 1;\n');
      writeFileSync(join(root, 'scripts/excluded.ts'), 'export const fixture: number = 1;\n');
      writeFileSync(join(root, 'scripts/unenrolled.mjs'), 'export const fixture = 1;\n');
      writeFileSync(join(root, 'scripts/tsconfig.json'), JSON.stringify({
        compilerOptions: { noEmit: true, types: [], lib: ['es2022'] },
        files: ['included.ts'],
      }));
      writeFileSync(join(root, 'baseline.json'), JSON.stringify({ files: {} }));
      writeFileSync(join(root, 'run.mjs'),
        `import {runTscBaselineGate} from ${JSON.stringify(gateUrl)};\n` +
        `await runTscBaselineGate(${JSON.stringify({
          root, baselineFile: join(root, 'baseline.json'), label: 'coverage-fixture',
          tscCommand: 'npx tsc -p scripts/tsconfig.json --noEmit --incremental false',
          argv: [`--files=${files.join(',')}`],
        })});\n`,
      );
      const socketPath = join(root, 'service.sock');
      if (server) await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      const options = {
        cwd: root,
        encoding: 'utf-8' as const,
        // This child runs a real tsc compile. Keep its deadline inside the shared
        // unit-test budget, leaving time for assertions and fixture cleanup. The
        // old local 15s cap redlined the full stateful lane while focused cases passed.
        timeout: Math.max(1_000, unitTestTimeoutMs - childFinalizationHeadroomMs),
        env: { ...process.env, PAPERCUSP_TSC_SERVICE: service ? '1' : '0',
          PAPERCUSP_TSC_SERVICE_SOCKET: socketPath, PAPERCUSP_TSC_SERVICE_UNIT_TEMPLATE: '' },
      };
      try {
        const result = await exec(process.execPath, [join(root, 'run.mjs')], options);
        return { code: 0, out: result.stdout + result.stderr };
      } catch (error: any) {
        return { code: error.code, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
      }
    } finally {
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }

  describe.each([['service', true], ['full compiler', false]] as const)('%s route', (_name, service) => {
    it.each(['scripts/unenrolled.mjs', 'scripts/excluded.ts'])(
      'refuses a clean verdict for the only named file %s absent from its program', async (file) => {
        const result = await runCoverageGate([file], service);
        expect(result.code).toBe(1);
        expect(result.out).toContain('NOTHING YOU NAMED WAS TYPECHECKED');
        expect(result.out).toContain('status=out-of-scope filesUnchecked=1');
        expect(result.out).not.toContain('status=clean');
      },
    );

    it('reports mixed actual coverage as partial without changing the covered verdict', async () => {
      const result = await runCoverageGate(['scripts/included.ts', 'scripts/unenrolled.mjs'], service);
      expect(result.code).toBe(0);
      expect(result.out).toContain('status=partial filesUnchecked=1');
      expect(result.out).not.toContain('status=clean');
    });

    it('keeps the enrolled TypeScript control clean', async () => {
      const result = await runCoverageGate(['scripts/included.ts'], service);
      expect(result.code).toBe(0);
      expect(result.out).toContain('status=clean');
      expect(result.out).not.toContain('filesUnchecked=');
    });
  });
});
