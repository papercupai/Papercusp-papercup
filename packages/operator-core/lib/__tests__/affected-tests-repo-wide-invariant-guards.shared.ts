/**
 * affected-tests-repo-wide-invariant-guards.shared.ts — shared probe helpers and fixture constants for the
 * affected-tests-repo-wide-invariant-guards*.test.ts suites (split by green-main-cycle-time-2026-10-08 P-004).
 *
 * WHY SPLIT: the single suite grew to ~211 tests, each spawning the real
 * affected-tests CLI (~2s locally, ~12-20s under gate load), and became the gate's
 * long pole (13.5 -> 43.4 min in one week of CI runs). Vitest parallelises across
 * FILES, never across tests inside one file, so the only cut that shortens the pole
 * is more files. Keep new guard sections in the topical shard they belong to and
 * keep every shard well under the gate-path file budget
 * (scripts/check-test-timing-budgets.mjs, file-duration class).
 *
 * The original suite's rationale follows verbatim.
 *
 * affected-tests-repo-wide-invariant-guards.test.ts — EI-19388389386110890 regression guard.
 *
 * ## The gap this covers
 *
 * `scripts/affected-tests.mjs` selects suites by WORKSPACE. That is right for a
 * test that covers its own workspace, and wrong for a check whose SCOPE is the
 * whole repository but which happens to live in one workspace's suite: the check
 * then runs only when its host workspace is independently affected.
 *
 * `child-output-guard.test.ts` is that shape. It enumerates via
 * `git ls-files --recurse-submodules` — ~20k TypeScript paths across 39
 * submodules — but it is a vitest file inside @papercusp/operator-core. So a
 * chunk-unsafe `stdout += String(chunk)` introduced anywhere ELSE produced no
 * local signal at all (test:affected green; lint:tsc is type-only and green) and
 * first surfaced hours later as a red FLEET gate blocking every agent. That is
 * the entire reported history of the class: five separate CORRECT fixes
 * (EI-19298378364087215, EI-19356631236774183, WI-6776, WI-6666/WI-6667), each
 * caught at the most expensive possible moment, each looking like fresh breakage
 * because each offender genuinely was new.
 *
 * `REPO_WIDE_INVARIANT_GUARDS` closes it by attaching a NARROW, cheap task
 * (~1s, 14 assertions) whenever a matching path changes anywhere.
 *
 * ## What this guard asserts, and what it does not
 *
 * It asserts BEHAVIOR through the real CLI's `--dry` probe (builds the task list,
 * runs nothing), never source text. It covers the four independent ways the
 * wiring silently reopens:
 *
 *   1. the guard stops being attached for changes outside its host workspace —
 *      the original bug, and the one that reads as "green" rather than as broken;
 *   2. it starts double-running when the host workspace IS affected (the whole
 *      suite already contains it) — cheap to miss, since duplicated work still
 *      passes;
 *   3. it fires for changes that cannot possibly violate the invariant;
 *   4. the `lint:chunk-safe` script disappears from operator-core's package.json,
 *      which would make the attachment a silent no-op — the same failure shape as
 *      WI-6077's missing `test` script;
 *   5. the vimock strand guard receives the runner's authoritative diff base, so
 *      git-sync cannot turn a selected guard run into a HEAD-vs-HEAD no-op.
 *
 * It does NOT assert that the guard itself is correct; that is
 * child-output-guard.test.ts's job.
 *  
 */
import { expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOkfScannedFile } from '../../../../scripts/check-okf-conformance.mjs';


export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const AFFECTED_TESTS = resolve(REPO_ROOT, 'scripts/affected-tests.mjs');

export const HOST_WORKSPACE = '@papercusp/operator-core';
export const DEPENDENCY_INTEGRITY_SCRIPT = 'lint:dependency-integrity';
export const DEPENDENCY_INTEGRITY_TASK = `${HOST_WORKSPACE} :: ${DEPENDENCY_INTEGRITY_SCRIPT}`;
export const TEST_RUNNABILITY_SCRIPT = 'lint:tests';
export const TEST_RUNNABILITY_TASK = `@papercusp/web :: ${TEST_RUNNABILITY_SCRIPT}`;
export const GUARD_SCRIPT = 'lint:chunk-safe';
export const GUARD_TASK = `${HOST_WORKSPACE} :: ${GUARD_SCRIPT}`;

/**
 * A TS path OUTSIDE the guard's host workspace. `apps/operator` is the measured
 * case from the filing: it routes to @papercusp/web, never to operator-core.
 */
export const OUTSIDE_TS_PATH = 'apps/operator/lib/release/deploy-cli.ts';
export const OUTSIDE_TS_BASENAME = basename(OUTSIDE_TS_PATH);
/** A test-only TS path the vimock export guard deliberately refuses to inspect. */
export const OUTSIDE_TEST_PATH = 'apps/operator/lib/verify-tauri-headless-quoting.test.ts';
/** A TS path INSIDE the host workspace, whose full `test` task already covers the guard. */
export const INSIDE_TS_PATH = 'packages/operator-core/lib/terminal-spawn.ts';
/** A non-source path that cannot introduce a stream accumulator. */
export const NON_SOURCE_PATH = 'apps/operator/docs/nuqs-audit-2026-05-11.md';
export const VIMOCK_GUARD_SCRIPT = 'lint:vimock-export-strands';
export const VIMOCK_GUARD_TASK = `${HOST_WORKSPACE} :: ${VIMOCK_GUARD_SCRIPT}`;

export const AUTHORED_DOC_SCRIPT = 'gen:authored-docs:check';
export const AUTHORED_DOC_TASK = `${HOST_WORKSPACE} :: ${AUTHORED_DOC_SCRIPT}`;
export const DOCS_ROOT = 'apps/operator-docs/src/content/docs';
export const AUTHORED_DOC_PATH = `${DOCS_ROOT}/agent-insights/a-cheap-repeating-beat-must-not-inherit-a-restart-sized-retry-budget.mdx`;
export const AUTHORED_DOC_ID = AUTHORED_DOC_PATH.slice(`${DOCS_ROOT}/`.length);
export const GENERATOR_OWNED_DOC_PATH = `${DOCS_ROOT}/reference/agent-insights-index.md`;
export const PROJECTOR_PATH = 'scripts/project-authored-docs.ts';
export const DOCS_CONFIG_PATH = '.papercusp/docs.json';

/**
 * Run the real CLI in --dry mode: it resolves the affected set and BUILDS the task
 * list, then exits without executing a suite. Deliberately the same probe shape the
 * standalone-packages guard uses — asserting on behavior keeps this test honest if
 * the mechanism is ever reimplemented differently.
 */
export function dryTasks(changedPaths: string, base?: string, probeEnv?: NodeJS.ProcessEnv): string {
  // A probe with the caller's own env is a deliberate one-off (the abort-path guard); never cache it.
  if (probeEnv) return dryTasksUncached(changedPaths, base, probeEnv);
  return memoProbe(`dry\u0000${changedPaths}\u0000${base ?? ''}`, () => dryTasksUncached(changedPaths, base));
}

/**
 * Per-file memo of identical CLI probes (green-main-cycle-time-2026-10-08 P-004).
 *
 * Each probe is a full `node scripts/affected-tests.mjs` start (~2s idle, 10-20s under
 * gate load), and the same (paths, base) pair is probed by several tests in a section.
 * The probe only READS the tree — no test in this family writes inside the repo — so
 * one run's output is the answer for every identical question in the same file. Every
 * assertion inside the uncached helpers still ran on that output once; a failing probe
 * throws and is NOT cached, so the next caller re-probes and fails with its own message.
 */
const probeMemo = new Map<string, string>();
function memoProbe(key: string, run: () => string): string {
  const hit = probeMemo.get(key);
  if (hit !== undefined) return hit;
  const out = run();
  probeMemo.set(key, out);
  return out;
}

function dryTasksUncached(changedPaths: string, base?: string, probeEnv?: NodeJS.ProcessEnv): string {
  const baseArgs = base ? ['--base', base] : [];
  const res = spawnSync(process.execPath, [AFFECTED_TESTS, '--changed-paths', changedPaths, ...baseArgs, '--dry'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    // `probeEnv` exists ONLY so the abort path above can be exercised by its own guard
    // without breaking a tracked file. Every production call leaves it undefined.
    ...(probeEnv ? { env: probeEnv } : {}),
  });
  // Fail loudly rather than letting a crashed probe read as "guard absent" — a
  // non-zero exit with empty stdout would otherwise satisfy every `not.toContain`.
  expect(res.error, `CLI failed to spawn: ${res.error?.message}`).toBeUndefined();
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  expect(out, 'probe produced no output — cannot conclude anything about task selection').not.toBe('');
  // A NON-ZERO exit means the CLI aborted BEFORE it routed anything, so this run says
  // nothing about task selection either way. Checking it is what stops the abort from
  // being misattributed: without it the next assertion is the one that fails, as
  // `expected 'file:///…' to contain 'AFFECTED_TESTS_RESULT'` — a message that names the
  // routing contract while the actual cause is a crash, and that truncates to the stack's
  // first line so the real error is not even visible. On this shared tree the usual cause
  // is a PEER's half-written file in the runner's import graph (measured 2026-08-30T15:07Z:
  // `constEMPTY_MARKER_DEBRIS_MS` — a missing space in scripts/lib/preempt-markers.mjs —
  // reddened this suite as if its routing had regressed). `--dry` builds the task list and
  // exits 0 on every path class, so a non-zero status here is never a legitimate verdict.
  expect(res.status, dryAbortDiagnostic(changedPaths, res.status, out)).toBe(0);
  expect(out, `CLI exited 0 but emitted no ${RESULT_MARKER} verdict line:\n${outputTail(out)}`).toContain(
    RESULT_MARKER,
  );
  return out;
}

export const RESULT_MARKER = 'AFFECTED_TESTS_RESULT';

/** Last `limit` lines of a probe's combined output — the part that carries the real error. */
export function outputTail(out: string, limit = 12): string {
  return out.trimEnd().split('\n').slice(-limit).join('\n');
}

/**
 * The message a reader gets when the probe CLI aborts. It must name the abort as the
 * subject and surface the underlying stack, because the failure it replaces pointed at
 * the routing contract instead and hid the cause.
 */
export function dryAbortDiagnostic(changedPaths: string, status: number | null, out: string): string {
  return [
    `affected-tests CLI ABORTED (exit ${status ?? 'null'}) before producing a ${RESULT_MARKER} verdict.`,
    'This is NOT a routing regression in the guard under test — the runner never got far enough',
    'to route anything. The usual cause is a syntax/module-load error in the runner\'s import',
    'graph, often a peer\'s in-flight edit on this shared tree; re-run once the tree is clean.',
    `  probed --changed-paths: ${changedPaths}`,
    '  CLI output (tail):',
    outputTail(out),
  ].join('\n');
}

export function commitSha(ref: string): string {
  const res = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(res.status, `could not resolve ${ref}: ${res.stderr ?? ''}`).toBe(0);
  const sha = (res.stdout ?? '').trim();
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  return sha;
}

/**
 * Resolve a MOVING ref once and hand the probe a stable spelling of that same commit.
 *
 * WI-10005544: passing `HEAD^` itself to the router let git-sync race the two resolutions.
 * The test resolved HEAD^ to 6b8aa9e5, git-sync committed twice, and the router then
 * resolved HEAD^ to d888157d, so the forwarded-base assertion failed although the guard
 * was attached correctly. The abbreviated sha cannot move, but it is still a ref the router
 * must expand to the full 40-char sha, so the ref-to-sha resolution stays exercised.
 */
export function pinnedBase(ref: string): { base: string; probeRef: string } {
  const base = commitSha(ref);
  return { base, probeRef: base.slice(0, 12) };
}

export function dryTaskLine(out: string, task: string): string {
  const line = out.split('\n').find((candidate) => candidate.includes(`:: ${task.split(' :: ')[1]}`));
  expect(line, `dry probe did not list ${task}:\n${out}`).toBeDefined();
  return line ?? '';
}

/**
 * Run the print-only probe through the real CLI. This must stay separate from
 * `dryTasks`: `--dry` prints human task descriptions, while `--print-affected`
 * is the machine-readable surface used by release-prefix tooling.
 */
export function printAffected(changedPaths: string, probeEnv?: NodeJS.ProcessEnv): string {
  if (probeEnv) return printAffectedUncached(changedPaths, probeEnv);
  return memoProbe(`print\u0000${changedPaths}`, () => printAffectedUncached(changedPaths));
}

function printAffectedUncached(changedPaths: string, probeEnv?: NodeJS.ProcessEnv): string {
  const res = spawnSync(process.execPath, [AFFECTED_TESTS, '--changed-paths', changedPaths, '--print-affected'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    ...(probeEnv ? { env: probeEnv } : {}),
  });
  expect(res.error, `CLI failed to spawn: ${res.error?.message}`).toBeUndefined();
  expect(res.status, `print-only probe failed:\n${res.stderr ?? ''}`).toBe(0);
  return `${res.stdout ?? ''}${res.stderr ?? ''}`;
}

/**
 * WI-2144309 / design-to-code-coverage-seam P-027 — the persistent venue is
 * deliberately expensive enough that it must be selected by a narrow guard,
 * not folded into every operator-core run. The integration test proves the
 * writer; these assertions prove the runner actually reaches it, and only for
 * inputs capable of breaking attribution.
 */
export const COVERAGE_ATTRIBUTION_VENUE_SCRIPT = 'test:coverage-attribution-venue';
export const COVERAGE_ATTRIBUTION_VENUE_TASK = `${HOST_WORKSPACE} :: ${COVERAGE_ATTRIBUTION_VENUE_SCRIPT}`;
export const COVERAGE_ATTRIBUTION_VENUE_PATH =
  'packages/operator-core/lib/coverage-census/attribution/persistence-venue.integration.test.ts';
export const COVERAGE_ATTRIBUTION_UNRELATED_PATH = 'packages/operator-core/lib/why-chain.ts';

/**
 * EI-21618443971639284 — committed generated su.md projections must not silently
 * fall behind the canonical base persona. The guard is deliberately registered
 * without a hostSuiteRatchet: this exact-byte check is a repo-root artifact
 * comparison, not something operator-core's ordinary Vitest suite executes.
 */
export const PROMPT_PROJECTION_SCRIPT = 'gen:prompt-projections:check';
export const PROMPT_PROJECTION_TASK = HOST_WORKSPACE + ' :: ' + PROMPT_PROJECTION_SCRIPT;
export const PROMPT_CANONICAL_PATH = 'libs/papercusp/packages/harness/blueprints/base/prompts/su.md';
export const PROMPT_DESKTOP_PROJECTION_PATH =
  'papercusp-desktop/src-tauri/env-sidecars/staging/harness/blueprints/base/prompts/su.md';
export const PROMPT_UNRELATED_PATH = 'apps/operator/docs/nuqs-audit-2026-05-11.md';

/** identities-v1 P-024 — a marker rename/miss must reach the exact-once guard
 * from every authored/projection tree, including bare submodule gitlinks. */
export const SU_SPLICE_MARKER_SCRIPT = 'lint:su-splice-markers';
export const SU_SPLICE_MARKER_TASK = HOST_WORKSPACE + ' :: ' + SU_SPLICE_MARKER_SCRIPT;

/**
 * agent-launch-context-cost-2026-09-18 P-004 — the shrink-only ceilings on the PROSE half
 * of a launch payload.
 *
 * ROUTING IS THE WHOLE RISK HERE, which is why it is pinned rather than trusted. The
 * largest governed surface is the repo-ROOT CLAUDE.md, which belongs to no workspace, and
 * the rest straddle apps/operator/prompts and operator-core — so the ONE change that grows
 * these surfaces (a prose edit) is precisely the change ordinary workspace selection
 * cannot route to the gate. A guard that is registered but never attached is exactly the
 * state the reachable-advisories entry above was written to describe: falsifiable, and
 * never run.
 */
export const LAUNCH_PROSE_BUDGET_SCRIPT = 'lint:launch-prose-budget';
export const LAUNCH_PROSE_BUDGET_TASK = HOST_WORKSPACE + ' :: ' + LAUNCH_PROSE_BUDGET_SCRIPT;

/**
 * WI-9434 — the SECOND instance of the class, wired the same way.
 *
 * `lint:partial-index-alignment` scans four roots but its ratchet ("the tree is
 * currently aligned") is a vitest file in @papercusp/operator-core, so three of
 * those four roots had no enforcement outside an operator-core-affecting change.
 *
 * The difference from chunk-safe, and why these tests are not a copy-paste: that
 * guard's enumeration is genuinely repo-wide, so its `appliesTo` is every TS file.
 * This one's scan is BOUNDED, so over-firing spends every agent's edit budget for a
 * finding that is impossible by construction — precision is part of the contract
 * here, and `does NOT attach for a TS file outside every scanned root` pins it.
 */
export const PI_SCRIPT = 'lint:partial-index-alignment';
export const PI_TASK = `${HOST_WORKSPACE} :: ${PI_SCRIPT}`;

/** A TS path under a scanned root that does NOT route to the host workspace. */
export const PI_OUTSIDE_PATH = 'apps/operator/lib/release/green-checkpoint.ts';
/** A TS path under NO scanned root — the lint could never read it. */
export const PI_UNSCANNED_PATH = 'apps/operator/app/adv/create/PreviewPanel.tsx';

/**
 * WI-35930 (okf-frontmatter-adoption-2026-08-08 P-006) — the FOURTH instance, and the
 * first whose corpus is written by CODE as well as by hand.
 *
 * `lint:okf-conformance` judges two corpora — the agent-insights docs and the
 * knowledge-packs (docs + `manifest.yaml`). Neither routes to a suite that covers it:
 * an insight doc selects `@papercupai/operator-docs`, which runs nothing over the
 * corpus, and a pack doc selects the pack workspace, likewise. So a doc that drops
 * `type:`, or writes a `stale_after:` no date parser accepts, produced ZERO local
 * signal before this wiring.
 *
 * Why the in-suite ratchet (`lib/okf-conformance-guard.test.ts`) is NOT sufficient on
 * its own, and why this narrow task exists: a standalone SCRIPT registered in
 * REPO_WIDE_INVARIANT_GUARDS is deliberately skipped when its host workspace is
 * independently affected, on the assumption the workspace suite already contains the
 * check. That assumption holds for `lint:chunk-safe` (a vitest file) and is FALSE for a
 * script — hence the ratchet. The two cover different halves and both are load-bearing.
 *
 * The pack half is the one that can regress with no author involved at all (plan D-003:
 * three code write paths mint that frontmatter), so the first notice of a regression
 * would otherwise be a red on files nobody edited.
 */
export const OKF_SCRIPT = 'lint:okf-conformance';
export const OKF_TASK = `${HOST_WORKSPACE} :: ${OKF_SCRIPT}`;

/**
 * A REAL tracked file under `root` that the lint would actually OPEN.
 *
 * Filtered through the lint's own `isOkfScannedFile`, not a hand-written extension
 * test, so the probe cannot select a file the lint declines to judge (which would
 * assert the guard fires for something it should not).
 *
 * `--recurse-submodules` because the packs root lives in `libs/papercusp`. Gate-shaped
 * checkouts carry 0/39 submodules (WI-6776), so this returns null there and the case
 * SKIPS — a guard test must not red the fleet gate over a checkout shape.
 */
export function realOkfFileUnder(root: string): string | null {
  const res = spawnSync('git', ['ls-files', '--recurse-submodules', root], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) return null;
  // WI-10004176: drop index entries a plain `rm` left behind until git-sync commits it.
  return (res.stdout ?? '').split('\n').filter((f) => existsSync(resolve(REPO_ROOT, f))).find((f) => f && isOkfScannedFile(f)) ?? null;
}

/**
 * WI-37605 — the D-034 shape straddling the boundary in BOTH directions.
 *
 * The invariant is "no executable line hardcodes the green-checkpoint production tag", and it was
 * violated in operator-core (release-actions.ts, 24 sites) AND in apps/operator
 * (green-checkpoint.ts, 13 sites). Its host workspace can only be one of the two, so whichever it
 * is, the other side's offender escapes selection — and apps/operator is the side that produced
 * the original report.
 *
 * Why it is worth every agent's edit budget: the violation changes no behaviour and breaks no
 * test, so it is invisible locally. It surfaces as a TRIAGER misreading a verdict log mid-incident,
 * because a captured suite line is byte-identical to a real gate decision.
 */
export const GC_TAG_SCRIPT = 'lint:green-checkpoint-tag';
export const GC_TAG_TASK = `${HOST_WORKSPACE} :: ${GC_TAG_SCRIPT}`;

/** Under a scanned root, routes to @papercusp/web — the measured escape case. */
export const GC_TAG_OUTSIDE_PATH = 'apps/operator/lib/release/green-checkpoint.ts';
/** Under NO scanned root: the guard could never read it, so attaching would be pure cost. */
export const GC_TAG_UNSCANNED_PATH = 'libs/flags/src/types.ts';

/**
 * EI-20032324229208320 — the mug/kettle retirement's recurrence guard
 * (retire-mug-kettle-su-only-2026-08-09 P-016).
 *
 * WHY THIS BLOCK EXISTS, and it is NOT the usual "route it to the offending workspace" reason.
 * The guard was registered in REPO_WIDE_INVARIANT_GUARDS *and* declared in the host workspace —
 * both steps done correctly — and it STILL held `main` red, because those two steps buy
 * COVERAGE, never ENFORCEMENT. `check-lint-guard-reachability.mjs`'s `buildCorpora()` reads
 * exactly four enforcement corpora: green-checkpoint.ts, .github/workflows/*, ENFORCING
 * *.test.ts, and hooks. `scripts/affected-tests.mjs` is not among them, so a repo-wide
 * registration can never make a guard "reachable" by itself — the guard landed in the
 * UNREACHABLE tier, past the shrink-only acknowledged set, and red-pinned the fleet's gate on
 * three cases at once (the unenforced-guard assertion plus both fail-open/PASS-output cases,
 * which only fail because the census exits nonzero).
 *
 * So the durable lesson this block pins is: EVERY repo-wide invariant guard needs a SECOND
 * wiring into an enforcement corpus. Measured at the time of writing — lint:no-retired -> 2
 * test files; lint:green-checkpoint-tag -> this file; lint:workspace-deps-complete -> CI
 * test.yml. This block is that second wiring for the mug/kettle guard, and it earns its place
 * by asserting the routing behaviour rather than merely naming the script.
 *
 * `npm run lint:no-ungated-mug-kettle` was verified exit 0 on the tree before wiring, so this
 * cannot red anyone's loop on pre-existing debt (same precaution the GC_TAG entry records).
 */
export const MUG_KETTLE_SCRIPT = 'lint:no-ungated-mug-kettle';
export const MUG_KETTLE_TASK = `${HOST_WORKSPACE} :: ${MUG_KETTLE_SCRIPT}`;

/** A TS path that routes to @papercusp/web, never pulling in the host workspace. */
export const MK_OUTSIDE_TS_PATH = 'apps/operator/lib/release/green-checkpoint.ts';
/** Markdown inside a package dir — blueprint PROMPTS are a census category, so `.md` counts. */
export const MK_MARKDOWN_PATH = 'apps/operator/docs/nuqs-audit-2026-05-11.md';
/** Active agentic template manifest — P-005's current-guidance family scans YAML too. */
export const MK_TEMPLATE_YAML_PATH = 'templates/papercusp-ops-pots/blueprints/app-agent/blueprint.yaml';
/** Matches the predicate NOWHERE: not TS/JS-family, not `.md`. */
export const MK_UNMATCHED_PATH = 'apps/operator/app/_brand-primitives.css';

/*
 * ── required-field-strands guard (WI-38401 / EI-20020054576584970) ────────────────────
 *
 * The guard existed, was tested, was documented in CLAUDE.md — and ran on NO automated
 * path, so the class it was built for froze `main` ~14h on 2026-08-12 with
 * `npm run test:affected` green throughout. Its only automated reach was a PostToolUse
 * nudge that fires solely inside Claude Code Edit|Write|MultiEdit sessions that have it
 * registered.
 *
 * Two halves of the registration can silently reopen that hole, and each fails GREEN:
 *
 *   1. the SUBMODULE half of `appliesTo`. A change inside a submodule reaches
 *      affected-tests.mjs ONLY as the submodule ROOT path (`libs/papercusp`) — the diffs
 *      run `--ignore-submodules=dirty` and `submoduleDirtyPaths()` reports the root — so a
 *      TS-family-only predicate cannot attach for 39 submodules' worth of source. The
 *      measured incident lives inside one, which is what makes this a correctness case and
 *      not a completeness nicety;
 *   2. the ENFORCED form. The registered `:typecheck` alias first performs the cheap AST
 *      trigger scan and only invokes `lint:tsc --files=...` when a changed exported shape
 *      actually adds a required field. That keeps ordinary edits at the ~1.7s parser cost
 *      while making the existing attributed typecheck fail on a real stranded site.
 */
export const RFS_SCRIPT = 'lint:required-field-strands:typecheck';
export const RFS_TASK = `${HOST_WORKSPACE} :: ${RFS_SCRIPT}`;
/** A TS path outside the host workspace (routes to @papercusp/web, never operator-core). */
export const RFS_OUTSIDE_TS_PATH = 'apps/operator/lib/release/deploy-cli.ts';
/** A non-source, non-submodule path: the negative half of the submodule differential. */
export const RFS_UNMATCHED_PATH = 'apps/operator/docs/nuqs-audit-2026-05-11.md';

/**
 * A REAL submodule root, read from `.gitmodules` rather than hardcoded, so retiring one
 * cannot leave this test asserting against a path that is no longer a submodule (which
 * would fail as a predicate regression while the predicate was fine).
 */
export function someSubmodulePath(): string {
  const res = spawnSync('git', ['config', '--file', '.gitmodules', '--get-regexp', 'path'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
  expect(res.status, `could not read .gitmodules: ${res.stderr ?? ''}`).toBe(0);
  const paths = (res.stdout ?? '')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(l.indexOf(' ') + 1).trim())
    .filter(Boolean);
  expect(paths.length, 'no submodules declared — the differential below proves nothing').toBeGreaterThan(0);
  // Prefer the submodule the measured incident came from; any real one exercises the clause.
  return paths.find((p) => p === 'libs/papercusp') ?? paths[0];
}
