/**
 * affected-tests-standalone-packages.test.ts — WI-6077 regression guard.
 *
 * `scripts/affected-tests.mjs` builds its universe of testable packages from root
 * `package.json`'s `workspaces` array. `papercusp-desktop` is a git SUBMODULE that is
 * deliberately NOT an npm workspace (it manages its own dependency graph and lockfile),
 * so it was invisible to that universe — and because the green gate's greenCmd is
 * `npm run test:affected` (release-config.ts), the gate ran ZERO of the desktop's ~20
 * guard suites: the deb/sidecar/reaper/config guards and the live-federation rig
 * selftests, i.e. exactly the release+packaging paths this repo ships.
 *
 * The fix joins such packages to the graph via `STANDALONE_PACKAGE_DIRS`, marking them
 * `standalone` so the runner invokes them with cwd=<dir> instead of
 * `npm run --workspace <dir>` (which resolves ONLY for genuine workspaces — it fails
 * with "No workspaces found", verified).
 *
 * This guard covers the three independent ways the gap silently reopens:
 *   1. the standalone registration is removed / renamed;
 *   2. the package loses its aggregate `test` script (the runner only builds a task
 *      when `ws.scripts.test` exists, so no `test` script == silently zero suites);
 *   3. someone "tidies" the submodule INTO root `workspaces`, which would break the
 *      standalone branch's premise and change npm's install/hoisting topology.
 *
 * It asserts BEHAVIOR, not source text: it runs the real CLI's `--print-affected`
 * probe, which exits before executing any suite.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS = resolve(REPO_ROOT, 'scripts/affected-tests.mjs');
const STANDALONE_DIR = 'papercusp-desktop';
const STANDALONE_PKG_NAME = '@papercusp/desktop';

const pkgAt = (rel: string) => JSON.parse(readFileSync(resolve(REPO_ROOT, rel, 'package.json'), 'utf8'));

describe('affected-tests: shared chat-card detectors', () => {
  it('routes renderer changes to standalone unit and integration tasks and their consumers', () => {
    const r = spawnSync('node', [AFFECTED_TESTS, '--changed-paths',
      'libs/generic/chat-cards/src/structured-results.tsx', '--integration', '--print-affected'], {
      cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      timeout: 300_000, killSignal: 'SIGKILL',
    });
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.split('\n');
    const commands = lines.filter(line => line.startsWith('AFFECTED_WS_CMD\t@papercusp/chat-cards\t'))
      .map(line => line.split('\t')[2]);
    expect(commands).toEqual(expect.arrayContaining([
      'npm --prefix libs/generic/chat-cards run --silent test',
      'npm --prefix libs/generic/chat-cards run --silent test:integration',
    ]));
    expect(lines).toContain('AFFECTED_WS\t@papercusp/operator-ui');
  });
});

// The submodule is not always checked out (a shallow/partial clone). Skip rather than
// fail there — a missing submodule is not a regression in this wiring.
const submodulePresent = existsSync(resolve(REPO_ROOT, STANDALONE_DIR, 'package.json'));

describe.skipIf(!submodulePresent)('affected-tests: standalone (non-workspace) packages (WI-6077)', () => {
  it('includes the standalone package in the affected universe', () => {
    // `--all --print-affected` enumerates the whole universe and exits before running
    // anything, so this is the cheapest honest probe of "can the runner even see it".
    const r = spawnSync('node', [AFFECTED_TESTS, '--all', '--print-affected'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 300_000,
      killSignal: 'SIGKILL',
    });
    expect(r.status, `affected-tests --print-affected failed:\n${r.stderr}`).toBe(0);

    const names = (r.stdout ?? '')
      .split('\n')
      .filter((l) => l.startsWith('AFFECTED_WS\t'))
      .map((l) => l.slice('AFFECTED_WS\t'.length).trim());

    expect(names.length).toBeGreaterThan(10); // sanity: the probe really enumerated
    expect(
      names,
      `${STANDALONE_PKG_NAME} is missing from the affected universe — the green gate is ` +
        `back to running ZERO of its suites. Check STANDALONE_PACKAGE_DIRS in scripts/affected-tests.mjs.`,
    ).toContain(STANDALONE_PKG_NAME);
  });

  it('declares an aggregate `test` script, without which the runner builds no task for it', () => {
    // affected-tests.mjs only queues a task when `ws.scripts.test` exists. A package in
    // the universe with no `test` script is therefore silently zero-coverage — the exact
    // second half of the original bug.
    const scripts = pkgAt(STANDALONE_DIR).scripts ?? {};
    expect(
      scripts.test,
      `${STANDALONE_DIR} has no \`test\` script, so affected-tests.mjs queues nothing for it.`,
    ).toBeTruthy();
  });

  it('excludes the heavy/VM-dependent suites from that aggregate script', () => {
    // These must never enter the gate's affected path: test:rust duplicates a separate
    // cargo step, and the live-matrix / updater-e2e suites need real VMs or network.
    const testScript: string = pkgAt(STANDALONE_DIR).scripts.test;
    for (const forbidden of ['test:rust', 'test:federation:live-matrix', 'test:updater-e2e-vm']) {
      expect(
        testScript.includes(forbidden),
        `${STANDALONE_DIR}'s \`test\` script must not run ${forbidden} — it is either already ` +
          `covered elsewhere or needs a VM/network, and would wreck the gate's wall-clock budget.`,
      ).toBe(false);
    }
  });

  it('is NOT an npm workspace — the standalone path exists precisely because it is not', () => {
    // If someone adds it to root `workspaces`, the standalone branch's premise breaks AND
    // npm's install/hoisting topology changes for a submodule that manages its own deps.
    // Fail here, loudly, rather than at install time or in a confusing gate error.
    const patterns: string[] = pkgAt('.').workspaces ?? [];
    const matches = patterns.some((p) =>
      p.endsWith('/*') ? STANDALONE_DIR.startsWith(p.slice(0, -2) + '/') : p === STANDALONE_DIR,
    );
    expect(
      matches,
      `${STANDALONE_DIR} appears in root package.json "workspaces". It is a submodule with its ` +
        `own dependency graph — keep it in STANDALONE_PACKAGE_DIRS instead.`,
    ).toBe(false);
  });

  // EI-22152426246970496. Being IN the universe is not enough: --print-affected has to
  // tell a consumer how to RUN it. A bare `AFFECTED_WS\t@papercusp/desktop` invites the
  // obvious `npm run --workspace @papercusp/desktop test`, which for a standalone package
  // exits 1 having measured ZERO tests — indistinguishable from a failing suite.
  describe('--print-affected emits a runnable command per selected task', () => {
    const printAffected = (changedPaths: string) => {
      const r = spawnSync(
        'node',
        [AFFECTED_TESTS, '--changed-paths', changedPaths, '--print-affected'],
        { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 300_000, killSignal: 'SIGKILL' },
      );
      expect(r.status, `--print-affected failed:\n${r.stderr}`).toBe(0);
      const lines = (r.stdout ?? '').split('\n');
      return {
        lines,
        cmds: lines
          .filter((l) => l.startsWith('AFFECTED_WS_CMD\t'))
          .map((l) => l.split('\t'))
          .map(([, workspace, command]) => ({ workspace, command })),
      };
    };

    it('gives the standalone package a command that does NOT use --workspace', () => {
      const { cmds } = printAffected(`${STANDALONE_DIR}/package.json`);
      const mine = cmds.filter((c) => c.workspace === STANDALONE_PKG_NAME);
      expect(mine.length, `no AFFECTED_WS_CMD line for ${STANDALONE_PKG_NAME}`).toBeGreaterThan(0);
      for (const { command } of mine) {
        // `npm run --workspace <standalone>` is the WRONG command: npm answers
        // "No workspaces found" and exits 1 without running a single test.
        expect(
          command,
          `suggested command for ${STANDALONE_PKG_NAME} uses --workspace, which cannot resolve a ` +
            `standalone package — it exits 1 having measured zero tests: ${command}`,
        ).not.toContain('--workspace');
        expect(command).toContain(STANDALONE_DIR);
      }
    });

    it('still uses --workspace for a genuine workspace (positive control)', () => {
      // Without this control the assertion above also passes if the command field were
      // empty, malformed, or never emitted for anyone.
      const { cmds } = printAffected('libs/flags/src/types.ts');
      const flags = cmds.filter((c) => c.workspace === '@papercusp/flags');
      expect(flags.length, 'no AFFECTED_WS_CMD line for @papercusp/flags').toBeGreaterThan(0);
      expect(flags[0]!.command).toContain('--workspace');
    });

    it('does not widen the AFFECTED_WS line that green-checkpoint parses', () => {
      // green-checkpoint.ts does `.slice('AFFECTED_WS\t'.length).trim()` and puts the
      // result in a Set of workspace NAMES. A tab appended to that line would corrupt
      // every name in the gate's targeted re-verdict, so the command MUST live on its
      // own line kind. (AFFECTED_WS_CMD deliberately fails a startsWith('AFFECTED_WS\t')
      // filter: the 12th character is '_', not a tab.)
      const { lines } = printAffected(`${STANDALONE_DIR}/package.json`);
      const wsLines = lines.filter((l) => l.startsWith('AFFECTED_WS\t'));
      expect(wsLines.length).toBeGreaterThan(0);
      for (const line of wsLines) {
        expect(
          line.split('\t').length,
          `AFFECTED_WS gained a field — green-checkpoint.ts would read "${line
            .slice('AFFECTED_WS\t'.length)
            .trim()}" as a workspace name.`,
        ).toBe(2);
      }
    });
  });
});

// WI-10003821 — the packaged-desktop WDIO runner. Its runner guards
// (tools/perf-test/wdio/perf-report.node-test.ts) were selected by NO gate task: a change to
// perf-report.ts resolved to zero workspaces. It is now a STANDALONE package, and its `test`
// script is the headless guard suite (the GUI run is `test:all`).
const WDIO_DIR = 'tools/perf-test/wdio';
const WDIO_PKG_NAME = '@papercusp/perf-test-wdio';

describe.skipIf(!existsSync(resolve(REPO_ROOT, WDIO_DIR, 'package.json')))(
  'affected-tests: the WDIO runner package is gated headlessly (WI-10003821)',
  () => {
    it('a change to the runner selects its own `test` task through --prefix', () => {
      const r = spawnSync(
        'node',
        [AFFECTED_TESTS, '--changed-paths', `${WDIO_DIR}/perf-report.ts`, '--print-affected'],
        { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 300_000, killSignal: 'SIGKILL' },
      );
      expect(r.status, `--print-affected failed:\n${r.stderr}`).toBe(0);
      const cmds = (r.stdout ?? '')
        .split('\n')
        .filter((l) => l.startsWith(`AFFECTED_WS_CMD\t${WDIO_PKG_NAME}\t`))
        .map((l) => l.split('\t')[2]);
      expect(
        cmds,
        `${WDIO_PKG_NAME} selected no task — its runner guards are back to running in no gate. ` +
          `Check STANDALONE_PACKAGE_DIRS in scripts/affected-tests.mjs.`,
      ).toEqual([`npm --prefix ${WDIO_DIR} run --silent test`]);
    });

    it('the `test` script that task runs never reaches the GUI suite', () => {
      const scripts: Record<string, string> = pkgAt(WDIO_DIR).scripts ?? {};
      expect(scripts.test).toBeTruthy();
      expect(scripts.test, 'a gate box cannot boot the packaged binary').not.toMatch(/test:wdio|wdio run/);
    });
  },
);
