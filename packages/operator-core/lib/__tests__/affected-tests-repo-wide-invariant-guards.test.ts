/**
 * affected-tests-repo-wide-invariant-guards.test.ts — core routing guards (prompt/splice/prose triggers, host-suite skip, zero-workspace, print-affected).
 *
 * One shard of the affected-tests-repo-wide-invariant-guards*.test.ts family (split by
 * green-main-cycle-time-2026-10-08 P-004 so the gate can run the shards in
 * parallel). The suite's rationale, probe helpers and fixture constants live in
 * ./affected-tests-repo-wide-invariant-guards.shared.ts — read its header before adding a section here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXIT_NOT_CHECKED } from '../../../../scripts/lib/not-checked.mjs';
import {
  AFFECTED_TESTS,
  AUTHORED_DOC_ID,
  AUTHORED_DOC_PATH,
  AUTHORED_DOC_TASK,
  COVERAGE_ATTRIBUTION_UNRELATED_PATH,
  COVERAGE_ATTRIBUTION_VENUE_PATH,
  COVERAGE_ATTRIBUTION_VENUE_SCRIPT,
  COVERAGE_ATTRIBUTION_VENUE_TASK,
  DEPENDENCY_INTEGRITY_SCRIPT,
  DEPENDENCY_INTEGRITY_TASK,
  DOCS_CONFIG_PATH,
  GENERATOR_OWNED_DOC_PATH,
  GUARD_SCRIPT,
  GUARD_TASK,
  HOST_WORKSPACE,
  INSIDE_TS_PATH,
  LAUNCH_PROSE_BUDGET_SCRIPT,
  LAUNCH_PROSE_BUDGET_TASK,
  NON_SOURCE_PATH,
  OUTSIDE_TEST_PATH,
  OUTSIDE_TS_BASENAME,
  OUTSIDE_TS_PATH,
  PROJECTOR_PATH,
  PROMPT_CANONICAL_PATH,
  PROMPT_DESKTOP_PROJECTION_PATH,
  PROMPT_PROJECTION_SCRIPT,
  PROMPT_PROJECTION_TASK,
  PROMPT_UNRELATED_PATH,
  REPO_ROOT,
  RESULT_MARKER,
  SU_SPLICE_MARKER_SCRIPT,
  SU_SPLICE_MARKER_TASK,
  TEST_RUNNABILITY_SCRIPT,
  TEST_RUNNABILITY_TASK,
  VIMOCK_GUARD_TASK,
  dryTaskLine,
  dryTasks,
  pinnedBase,
  printAffected,
  someSubmodulePath,
} from './affected-tests-repo-wide-invariant-guards.shared';


describe('affected-tests: Phone media source recurrence', () => {
  it.each(['infra/phone-app/deploy.sh', 'infra/phone-app/media-config.mjs',
    'infra/phone-app/livekit-server.yaml.tmpl', 'infra/phone-app/livekit-sip.yaml.tmpl',
    'infra/phone-app/verify-media-plane.sh', 'apps/operator/e2e/phone-media-probe.spec.ts',
    'apps/operator/package.json'])
  ('selects all registered media layers for %s', path => {
    expect(printAffected(path)).toContain('test:phone-media');
  });

  it('keeps media integration coverage when the web unit suite is also selected', () => {
    expect(printAffected('infra/phone-app/deploy.sh,apps/operator/lib/use-workspace.ts')).toContain('test:phone-media');
  });

  it('does not select media tests for unrelated infrastructure', () => {
    expect(printAffected('infra/defguard/Caddyfile')).not.toContain('test:phone-media');
  });

  it('names real unit, integration and isolated e2e commands in its host workspace', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'apps/operator/package.json'), 'utf8'));
    const command: string = pkg.scripts['test:phone-media'];
    // Assert per `&&` segment, not as one contiguous substring: a segment may
    // legitimately list more test files before its `--config` (2026-10-06 the
    // unit segment gained phone-app-edge-config.test.ts and the old literal
    // 'hosted-config.test.ts --config vitest.config.ts' went red).
    const segments = command.split('&&').map(s => s.trim());
    const unit = segments.find(s => /\bphone-app-hosted-config\.test\.ts\b/.test(s));
    expect(unit, `no unit segment in: ${command}`).toBeDefined();
    expect(unit).toMatch(/^vitest run /);
    expect(unit).toContain('--config vitest.config.ts');
    const integration = segments.find(s => s.includes('phone-app-hosted-config.integration.test.ts'));
    expect(integration, `no integration segment in: ${command}`).toBeDefined();
    expect(integration).toMatch(/^vitest run /);
    expect(integration).toContain('--config vitest.integration.config.ts');
    expect(command).toContain('OPERATOR_E2E_REUSE_SERVER=1 playwright test e2e/phone-media-probe.spec.ts --workers=1');
  });
});

/**
 * EI-21943909516081455 — the probe must distinguish "the runner ABORTED" from "the runner
 * ran and routed wrongly".
 *
 * `dryTasks` spawns the runner out of the LIVE working tree, which on this shared checkout
 * is mutated continuously by other agents. When a peer's in-flight edit leaves a syntax
 * error anywhere in the runner's import graph, the spawn SUCCEEDS, the process exits
 * non-zero, and stderr carries a stack — so `res.error` is undefined and the output is
 * non-empty, and both pre-existing checks pass. The failure then landed on the marker
 * assertion and read as `expected 'file:///…' to contain 'AFFECTED_TESTS_RESULT'`: it named
 * the routing contract rather than the crash, and truncated to the stack's first line so the
 * actual error never appeared. Measured live on 2026-08-30T15:07:31Z.
 *
 * The crash is injected via NODE_OPTIONS into a throwaway module, never by mutating a
 * tracked file — a probe that edits the shared tree can be committed by the git-sync sweep
 * even when nothing goes wrong (see CLAUDE.md, "Proving a guard is falsifiable").
 */
describe('affected-tests: probe abort attribution (EI-21943909516081455)', () => {
  let crashDir = '';
  let crashModule = '';

  beforeAll(() => {
    crashDir = mkdtempSync(resolve(tmpdir(), 'affected-tests-abort-'));
    crashModule = resolve(crashDir, 'boom.mjs');
    writeFileSync(crashModule, "throw new ReferenceError('constEMPTY_MARKER_DEBRIS_MS is not defined');\n");
  });

  afterAll(() => {
    if (crashDir) rmSync(crashDir, { recursive: true, force: true });
  });

  function crashEnv(): NodeJS.ProcessEnv {
    return { ...process.env, NODE_OPTIONS: `--import ${pathToFileURL(crashModule).href}` };
  }

  function abortedProbe(): { status: number | null; out: string } {
    const res = spawnSync(process.execPath, [AFFECTED_TESTS, '--changed-paths', OUTSIDE_TS_PATH, '--dry'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      env: crashEnv(),
    });
    return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
  }

  it('an import-graph crash produces exactly the shape both pre-existing checks let through', () => {
    const { status, out } = abortedProbe();
    // The precondition that made the misattribution possible: not a spawn error, not empty
    // output — so only the exit status can tell an abort from a routing answer.
    expect(status, 'expected the injected crash to abort the runner').not.toBe(0);
    expect(out, 'a crashed runner still writes its stack, so the empty-output check cannot catch this').not.toBe(
      '',
    );
    expect(out).not.toContain(RESULT_MARKER);
  });

  it('reports the abort as the subject, and surfaces the underlying error instead of hiding it', () => {
    // The REAL helper, on the REAL abort path — not a re-derivation of it. Removing the
    // status check makes this throw the marker assertion instead, and every match below fails.
    let message = '';
    try {
      dryTasks(OUTSIDE_TS_PATH, undefined, crashEnv());
      expect.unreachable('the probe aborted, so dryTasks must not return a task list');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain('ABORTED');
    expect(message).toContain('NOT a routing regression');
    // The cause has to reach the reader; the assertion this replaces truncated it away.
    expect(message).toContain('ReferenceError');
    expect(message).toContain('constEMPTY_MARKER_DEBRIS_MS');
    // And it must NOT read as the routing-contract failure it used to be mistaken for.
    expect(message).not.toMatch(/expected .* to contain/);
  });

  it('a healthy run still exits 0 with a verdict, so the status check cannot red a clean tree', () => {
    const res = spawnSync(process.execPath, [AFFECTED_TESTS, '--changed-paths', OUTSIDE_TS_PATH, '--dry'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(res.status).toBe(0);
    expect(`${res.stdout ?? ''}${res.stderr ?? ''}`).toContain(RESULT_MARKER);
  });
});

describe('affected-tests: dependency-integrity preflight (EI-20863794002653922)', () => {
  it('attaches for an ordinary change outside the host workspace', () => {
    expect(dryTasks(OUTSIDE_TS_PATH)).toContain(DEPENDENCY_INTEGRITY_TASK);
  });

  it('still attaches when the host suite is selected because that suite cannot inspect its own runner before startup', () => {
    const out = dryTasks(INSIDE_TS_PATH);
    expect(out).toContain(`${HOST_WORKSPACE} :: test`);
    expect(out).toContain(DEPENDENCY_INTEGRITY_TASK);
  });

  it('keeps the host script pointed at the reused detector and guarded by the install mutex', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const command = pkg.scripts?.[DEPENDENCY_INTEGRITY_SCRIPT];

    expect(command).toBeTruthy();
    expect(command).toContain('npm-install-safe.mjs');
    expect(command).toContain('--exec-under-lock');
    expect(command).toContain('check-declared-deps-extracted.mjs');
    expect(command).not.toContain('vitest');
  });
});

describe('affected-tests: registry-test runnability invariant (EI-15951)', () => {
  it.each([
    'tools/perf-test/wdio/specs/smoke.spec.ts',
    'apps/operator/playwright.config.ts',
    'libs/test-config/src/vitest-config.ts',
    '.papercusp/testing-domains.json',
  ])('attaches lint:tests when %s can change executor coverage', (changedPath) => {
    expect(dryTasks(changedPath)).toContain(TEST_RUNNABILITY_TASK);
  });

  it('does not attach the executor audit for an unrelated prose-only change', () => {
    expect(dryTasks(NON_SOURCE_PATH)).not.toContain(TEST_RUNNABILITY_TASK);
  });

  it('keeps the selected lint task defined on its host workspace', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'apps/operator/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.[TEST_RUNNABILITY_SCRIPT]).toBe('tsx scripts/lint-tests.ts');
  });
});

describe('affected-tests: repo-wide invariant guards (EI-19388389386110890)', () => {
  it('attaches the chunk-safe guard for a TS change OUTSIDE its host workspace', () => {
    const out = dryTasks(OUTSIDE_TS_PATH);
    // The regression: before this wiring, operator-core was simply absent here.
    expect(
      out,
      `a TS change at ${OUTSIDE_TS_PATH} must still run the repo-wide chunk-safe guard; ` +
        'without it, a chunk-unsafe accumulator introduced outside operator-core gets ' +
        'ZERO local signal and first reds the shared gate hours later',
    ).toContain(GUARD_TASK);
  });

  it('expands a file-level basename before selecting workspaces or forwarding guard files', () => {
    const { base, probeRef: baseRef } = pinnedBase('HEAD^');
    const out = dryTasks(OUTSIDE_TS_BASENAME, baseRef);
    expect(
      out,
      `a file runner may report only ${OUTSIDE_TS_BASENAME}; affected-tests must resolve it ` +
        `to ${OUTSIDE_TS_PATH} before computing the workspace closure`,
    ).toContain('@papercusp/web :: test');
    expect(
      out,
      'repo-wide guards must receive the resolved repository-relative path, not an unresolvable basename',
    ).toContain(`${VIMOCK_GUARD_TASK} (guard base: ${base}) (guard args: --files=${OUTSIDE_TS_PATH})`);
  });

  it('does NOT double-run it when the host workspace is already affected', () => {
    const out = dryTasks(INSIDE_TS_PATH);
    expect(out, 'the host workspace should run its own suite here').toContain(`${HOST_WORKSPACE} :: test`);
    expect(
      out,
      `${HOST_WORKSPACE}'s full test suite already contains child-output-guard.test.ts, so ` +
        'attaching the narrow task as well would run the same assertions twice',
    ).not.toContain(GUARD_TASK);
  });

  it('does NOT attach it for a change that cannot violate the invariant', () => {
    const out = dryTasks(NON_SOURCE_PATH);
    expect(
      out,
      'the guard is paid for by every agent on every edit; attaching it to non-source ' +
        'changes spends that budget for no possible finding',
    ).not.toContain(GUARD_TASK);
  });

  it('keeps the guard script defined, so the attachment cannot silently no-op', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(
      pkg.scripts?.[GUARD_SCRIPT],
      `${HOST_WORKSPACE} must define "${GUARD_SCRIPT}". The router only builds a task when ` +
        'the script exists, so removing it re-opens the gap silently — the run stays green ' +
        'and simply stops checking (the WI-6077 missing-`test`-script failure shape).',
    ).toBeTruthy();
    expect(pkg.scripts?.[GUARD_SCRIPT]).toContain('child-output-guard.test.ts');
  });

  it('forwards the runner base and exact triggering paths to the vimock strand guard', () => {
    const { base, probeRef: baseRef } = pinnedBase('HEAD^');
    const out = dryTasks(OUTSIDE_TS_PATH, baseRef);
    expect(
      out,
      `${VIMOCK_GUARD_TASK} must receive the same base that affected-tests used for its ` +
        'authoritative changed-path derivation AND the exact triggering paths; otherwise ' +
        'git-sync leaves the guard comparing HEAD with itself or widens attribution to peers',
    ).toContain(`${VIMOCK_GUARD_TASK} (guard base: ${base}) ` + `(guard args: --files=${OUTSIDE_TS_PATH})`);
  });

  it('does NOT attach the vimock strand guard for a test-only change it cannot inspect', () => {
    const out = dryTasks(OUTSIDE_TEST_PATH);
    expect(out).toContain('@papercusp/web :: test');
    expect(
      out,
      'the guard deliberately skips test/spec files because their own exports are not mocked ' +
        'production surfaces; scheduling it here guarantees EXIT_NOT_CHECKED and falsely makes ' +
        'an otherwise-green test-only affected run non-green',
    ).not.toContain(VIMOCK_GUARD_TASK);
  });

  it('attaches and forwards a SUBMODULE ROOT — the only superproject path for internal edits', () => {
    const { base, probeRef: baseRef } = pinnedBase('HEAD^');
    const submodule = someSubmodulePath();
    expect(
      dryTasks(submodule, baseRef),
      `a runtime export added inside ${submodule} reaches affected-tests only as the bare ` +
        'gitlink path; a TS-extension-only predicate silently omits the guard for the whole submodule',
    ).toContain(`${VIMOCK_GUARD_TASK} (guard base: ${base}) ` + `(guard args: --files=${submodule})`);
  });
});

describe('affected-tests: persistent coverage-attribution venue guard (WI-2144309)', () => {
  it.each([COVERAGE_ATTRIBUTION_VENUE_PATH, 'scripts/affected-tests.mjs'])(
    'attaches the venue for an owned input: %s',
    (changedPath) => {
      expect(
        dryTasks(changedPath),
        `${changedPath} can break the persistence venue or its selection; the dedicated ` +
          'integration task must be present even when operator-core is already affected',
      ).toContain(COVERAGE_ATTRIBUTION_VENUE_TASK);
    },
  );

  it('does NOT attach the database venue to unrelated operator-core source', () => {
    expect(
      dryTasks(COVERAGE_ATTRIBUTION_UNRELATED_PATH),
      'the venue has a measured database cost and must not become an all-operator-core tax',
    ).not.toContain(COVERAGE_ATTRIBUTION_VENUE_TASK);
  });

  it('keeps the venue script defined, so selection cannot silently no-op', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const script = pkg.scripts?.[COVERAGE_ATTRIBUTION_VENUE_SCRIPT];
    expect(script, 'affected-tests only queues guards whose workspace script exists').toBeTruthy();
    expect(script).toContain('PAPERCUSP_TEST_ATTRIBUTION=1');
    expect(script).toContain('persistence-venue.integration.test.ts');
  });
});

describe('affected-tests: generated su.md projection guard (EI-21618443971639284)', () => {
  it.each([PROMPT_CANONICAL_PATH, PROMPT_DESKTOP_PROJECTION_PATH])(
    'attaches for a changed projection input: %s',
    (changedPath) => {
      expect(
        dryTasks(changedPath),
        changedPath + ' can change the bytes served by a generated su.md consumer, so ' +
          'the exact-byte projection guard must run even when no ordinary workspace test ' +
          'would inspect the generated artifact',
      ).toContain(PROMPT_PROJECTION_TASK);
    },
  );

  it('does not attach for an unrelated prose path', () => {
    expect(
      dryTasks(PROMPT_UNRELATED_PATH),
      'a documentation edit outside the canonical prompt and generated projections cannot ' +
        'change this byte-equality invariant',
    ).not.toContain(PROMPT_PROJECTION_TASK);
  });

  it('keeps the guard script defined on the host workspace', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.[PROMPT_PROJECTION_SCRIPT]).toContain('check-prompt-projections.mjs');
  });
});

describe('affected-tests: SU splice-marker exact-once guard (identities-v1 P-024)', () => {
  it.each([
    'libs/papercusp',
    'libs/papercusp/packages/harness/blueprints/base/prompts/su.md',
    'apps/operator/prompts/papercusp-su-engineer.tools.md',
    'packages/operator-core/lib/desktop-install/splice-tooling-overlay.ts',
    'packages/operator-core/lib/desktop-install/__fixtures__/su-render-baseline/su.base.md',
    'papercusp-desktop',
    'papercusp-desktop/src-tauri/env-sidecars/staging/harness/blueprints/base/prompts/su.md',
    'scripts/check-su-splice-markers.ts',
  ])('attaches for a splice-contract input: %s', (changedPath) => {
    expect(dryTasks(changedPath)).toContain(SU_SPLICE_MARKER_TASK);
  });

  it('does not attach for an unrelated prose path', () => {
    expect(dryTasks(PROMPT_UNRELATED_PATH)).not.toContain(SU_SPLICE_MARKER_TASK);
  });

  it('keeps the guard script defined on the host workspace', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.[SU_SPLICE_MARKER_SCRIPT]).toContain('check-su-splice-markers.ts');
  });
});

describe('affected-tests: launch prose byte-budget guard (agent-launch-context-cost-2026-09-18 P-004)', () => {
  it.each([
    // The project guide — repo root, owned by no workspace suite.
    'CLAUDE.md',
    // The authored playbook bases and a client overlay.
    'apps/operator/prompts/papercusp-su-engineer.tools.md',
    'apps/operator/prompts/papercusp-su-power.tools.md',
    'apps/operator/prompts/papercusp-su.codex.md',
    // The compaction protocol sources.
    'apps/operator/prompts/papercusp-compaction.base.md',
    // The renderer — a splice change moves every measured number at once.
    'packages/operator-core/lib/desktop-install/papercusp-files.ts',
    // The gate, its comparison module and its baseline each decide what "clean" means.
    'scripts/check-launch-prose-budget.ts',
    'scripts/launch-prose-budget-baseline.json',
    'packages/operator-core/lib/launch-prose-budget.ts',
  ])('attaches for a governed prose surface or its instrument: %s', (changedPath) => {
    expect(dryTasks(changedPath)).toContain(LAUNCH_PROSE_BUDGET_TASK);
  });

  it('does not attach for an unrelated prose path', () => {
    expect(dryTasks(PROMPT_UNRELATED_PATH)).not.toContain(LAUNCH_PROSE_BUDGET_TASK);
  });

  it('does not attach for ordinary source that cannot change a prose surface', () => {
    expect(dryTasks(OUTSIDE_TS_PATH)).not.toContain(LAUNCH_PROSE_BUDGET_TASK);
  });

  it('STILL attaches when operator-core is affected — its suite never renders the real tree', () => {
    // No hostSuiteRatchet by design: the unit tests drive the comparison against fixtures,
    // but only this task renders the actual playbook and measures the actual files. If a
    // ratchet were ever added, this assertion is what would catch the resulting blind spot.
    expect(dryTasks('packages/operator-core/lib/launch-prose-budget.ts')).toContain(LAUNCH_PROSE_BUDGET_TASK);
  });

  it('keeps the guard script defined on the host workspace', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.[LAUNCH_PROSE_BUDGET_SCRIPT]).toContain('check-launch-prose-budget.ts');
  });

  it('keeps every declared surface in the baseline paired with a stated reason', () => {
    // A ceiling with an empty `note` is a number nobody can evaluate later: the next agent
    // to hit a red has to guess whether the surface may grow. The note is the only place
    // that answer lives.
    const baseline = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'scripts/launch-prose-budget-baseline.json'), 'utf8'),
    ) as { ceilings: Array<{ surface: string; ceilingBytes: number; floorBytes: number; note: string }> };
    expect(baseline.ceilings.length).toBeGreaterThan(0);
    for (const c of baseline.ceilings) {
      expect(c.note.trim().length, `${c.surface} needs a stated reason`).toBeGreaterThan(40);
      expect(c.floorBytes, `${c.surface} floor must sit below its ceiling`).toBeLessThan(c.ceilingBytes);
      expect(c.floorBytes, `${c.surface} needs a real plausibility floor`).toBeGreaterThan(0);
    }
  });
});

describe('affected-tests: authored-doc guard candidate scope (EI-21079330201572062)', () => {
  it('passes the exact changed authored doc to the guard', () => {
    const line = dryTaskLine(dryTasks(AUTHORED_DOC_PATH), AUTHORED_DOC_TASK);
    expect(line).toContain(`(guard args: --files=${AUTHORED_DOC_ID})`);
  });

  it('excludes unrelated changed paths from the authored-doc allowlist', () => {
    const line = dryTaskLine(dryTasks(`${AUTHORED_DOC_PATH},${OUTSIDE_TS_PATH}`), AUTHORED_DOC_TASK);
    expect(line).toContain(`(guard args: --files=${AUTHORED_DOC_ID})`);
    expect(line).not.toContain(OUTSIDE_TS_PATH);
  });

  it('filters generator-owned docs when an authored doc changes alongside one', () => {
    const line = dryTaskLine(dryTasks(`${AUTHORED_DOC_PATH},${GENERATOR_OWNED_DOC_PATH}`), AUTHORED_DOC_TASK);
    expect(line).toContain(`(guard args: --files=${AUTHORED_DOC_ID})`);
    expect(line).not.toContain('reference/agent-insights-index.md');
  });

  it.each([PROJECTOR_PATH, DOCS_CONFIG_PATH])(
    'keeps the guard full-corpus for projector/config changes: %s',
    (changedPath) => {
      const line = dryTaskLine(dryTasks(changedPath), AUTHORED_DOC_TASK);
      expect(line).not.toContain('(guard args:');
      expect(line).not.toContain('--files=');
    },
  );
});

/*
 * EI-20026978310669562 — the RECURRENCE GUARD for the class the whole registry above exists
 * to prevent, one level up.
 *
 * The router may skip a guard in favour of its host workspace's full suite ONLY when that
 * suite genuinely re-runs the invariant. That used to be an ASSUMPTION baked into a single
 * `t.script === 'test'` comparison, held for every guard uniformly, and true for only 5 of
 * 12 — so a guard could stop firing with no failing test anywhere, triggered by something as
 * unrelated as a dependency-graph edit three files away (declaring @papercusp/db-org on
 * operator-core made libs/papercusp/** reach the host workspace, silently disabling
 * lint:migration-forward-compat for migration .sql changes).
 *
 * The premise is now DECLARED per guard via `hostSuiteRatchet`. That fixes the mechanism but
 * moves the risk rather than removing it: a DECLARATION is just a new place to write an
 * unverified claim, and a phantom ratchet — a path that does not exist, or a file that never
 * runs the invariant — buys back the identical silent hole while LOOKING rigorous. So the
 * declaration is checked here, not trusted.
 *
 * Deliberately NOT asserted: that guards without a ratchet attach unconditionally. That is a
 * BEHAVIOURAL claim and is pinned behaviourally by the forward-compat block above, which
 * probes a path satisfying both halves at once (matches the predicate AND pulls the host
 * workspace in). A source-shape assertion here would duplicate it in a weaker form.
 */
describe('affected-tests: the host-suite skip is DECLARED and verified, never assumed', () => {
  type Guard = { script: string; hostSuiteRatchet: string | null; notCheckedIsNonGating: boolean };

  // The registry SOURCE is overridable so this block's falsifiability can be proven against a
  // mutated COPY outside the tree (scripts/mutation-probe.sh tier 2). The shared checkout is
  // edited by the whole fleet and swept into commits every few minutes, so mutating
  // affected-tests.mjs in place to test these assertions would risk committing the mutant —
  // this one line is what makes the safe probe available. Defaults to the real file.
  const REGISTRY_FILE = process.env.PROBE_AFFECTED_TESTS ?? AFFECTED_TESTS;

  const registrySource = (() => {
    const src = readFileSync(REGISTRY_FILE, 'utf8').replaceAll('"', "'");
    const start = src.indexOf('const REPO_WIDE_INVARIANT_GUARDS');
    return src.slice(start, src.indexOf('\n];', start));
  })();

  const guards: Guard[] = registrySource
    .split(/\n {2}\{\n/)
    .slice(1)
    .map((chunk) => {
      const script = /script: '([^']+)'/.exec(chunk)?.[1];
      const ratchet = /hostSuiteRatchet: '([^']+)'/.exec(chunk)?.[1] ?? null;
      const nonGating = /notCheckedIsNonGating: true/.test(chunk);
      return script ? { script, hostSuiteRatchet: ratchet, notCheckedIsNonGating: nonGating } : null;
    })
    .filter((g): g is Guard => g !== null);

  it('CALIBRATION — the registry parse actually found the guards', () => {
    // Without this, a parse that silently yielded [] would make every it.each below vacuous:
    // zero cases, green suite, zero protection. The declared count is cross-checked against
    // the raw `script:` occurrences so a new entry shape cannot quietly fall out of the scan.
    const rawCount = (registrySource.match(/\n\s*script: '/g) ?? []).length;
    expect(guards.length, `parsed ${guards.length} guard(s) from a registry with ${rawCount}`).toBe(rawCount);
    expect(guards.length).toBeGreaterThanOrEqual(10);
    // Shape, not namespace. This asserted `startsWith('lint:')` until the registry took its
    // first non-lint entry (`gen:authored-docs:check` — a projected-doc drift check, which is
    // a repo-wide invariant like any other and belongs here). That made a CALIBRATION fail for
    // a correct registration, which is the worst failure mode a calibration has: it reads as
    // "the parse broke" while the parse is fine, and the cheap way out is to weaken it to
    // nothing. What the calibration actually needs to prove is that the parse yielded real npm
    // script names rather than garbage or [], so pin THAT — a namespaced `<group>:<name>` — and
    // let the registry grow a new namespace without a false red.
    expect(guards.every((g) => /^[a-z][\w-]*:[\w:-]+$/.test(g.script))).toBe(true);
  });

  /**
   * WI-37826 — "I could not look" must never gate, and the registry is where that is declared.
   *
   * The strand-guard family answers THREE things: 0 checked-and-clean, 1 checked-and-found,
   * 2 could-not-look (EXIT_NOT_CHECKED). The router gates on `status !== 0`, so registering
   * one of these guards without `notCheckedIsNonGating` turns its third answer into a red.
   * And it reds EVERY time rather than intermittently: a gate checkout is clean by
   * construction, so a guard whose subject is the working diff examines zero files on every
   * candidate.
   *
   * MEASURED 2026-08-10: `lint:vimock-export-strands` was registered under the comment "it
   * always exits 0, so it can never red the gate". WI-37806 then made it exit 2 when it
   * examined nothing — correct in itself, and a fleet-wide gate red the moment the gate's
   * checkout picked it up. Nothing connected the two changes, because the guard's exit
   * contract lived in the guard and its consequences lived here.
   */
  it('every registered guard that CAN exit "not checked" declares it non-gating', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    let checked = 0;
    for (const g of guards) {
      const cmd = pkg.scripts?.[g.script];
      if (!cmd) continue;
      // The guard's own source is the authority on whether exit 2 is reachable — asking the
      // file rather than maintaining a second list of "the strand guards" here, which would
      // be one more thing to forget to update.
      const file = /scripts\/[\w.-]+\.mjs/.exec(cmd)?.[0];
      if (!file) continue;
      let src: string;
      try {
        src = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      } catch {
        continue;
      }
      if (!/from '\.\/lib\/not-checked\.mjs'/.test(src)) continue;
      checked++;
      expect(
        g.notCheckedIsNonGating,
        `${g.script} runs ${file}, which imports not-checked.mjs and so can exit ${EXIT_NOT_CHECKED} ` +
          `("examined nothing"). Registered without notCheckedIsNonGating, that answer reds the gate ` +
          `on every candidate, since a gate checkout's working diff is empty by construction.`,
      ).toBe(true);
    }
    // Without this the loop is vacuous the moment the import pattern changes — the same
    // zero-cases-green-suite failure the CALIBRATION test above exists to prevent.
    expect(checked, 'no registered guard was recognised as strand-family — parse is stale').toBeGreaterThan(0);
  });

  it('the RUNNER actually honours notCheckedIsNonGating — the not-checked branch must not touch the gating counter', () => {
    // The declaration test above asserts every strand-family guard IS registered
    // notCheckedIsNonGating, and its own failure message states the reason: registered without
    // it, "that answer reds the gate on every candidate". That belief was FALSE for as long as
    // the consumer ignored the flag. classifyTaskExit correctly separated 'not-checked' from
    // 'undetermined', and then BOTH branches did `undeterminedTasks++` — the one counter that
    // decides the verdict (`hasFailures: Boolean(failed || undeterminedTasks)`). So a guard that
    // had declared it has no opinion red-pinned every candidate anyway, and the declaration test
    // stayed green throughout because it only ever read the REGISTRATION side.
    //
    // Measured on candidate 57483d0491 (2026-08-30): the gate's own log read
    //   "lint:required-field-strands:typecheck NOT CHECKED (exit 2) — verdict is UNDETERMINED;
    //    not retrying and keeping the affected-tests run non-green."
    // This test pins the CONSUMER half so the pair cannot drift apart again.
    const src = readFileSync(REGISTRY_FILE, 'utf8');
    const branch = /exitClass === "not-checked"\)\s*\{([\s\S]*?)\}\s*else if/.exec(src)?.[1];
    expect(branch, 'the not-checked branch is no longer recognisable in affected-tests.mjs — parse is stale').toBeDefined();
    expect(
      /undeterminedTasks\+\+/.test(branch as string),
      'the not-checked branch increments undeterminedTasks, which is what the verdict gates on. ' +
        'A guard registered notCheckedIsNonGating declared that "I could not look" is its EXPECTED ' +
        'answer here (a gate checkout has an empty working diff by construction), so gating on it ' +
        'reds EVERY candidate unconditionally.',
    ).toBe(false);
    expect(
      /notCheckedNonGating\+\+/.test(branch as string),
      'the not-checked branch must still COUNT the skipped guard on a non-gating counter, so the ' +
        'coverage gap stays visible rather than being silently swallowed',
    ).toBe(true);
  });

  it("the router's mirrored EXIT_NOT_CHECKED equals the real one", () => {
    const src = readFileSync(REGISTRY_FILE, 'utf8');
    const mirrored = /const EXIT_NOT_CHECKED = (\d+);/.exec(src)?.[1];
    expect(mirrored, 'affected-tests.mjs no longer declares EXIT_NOT_CHECKED').toBeDefined();
    expect(Number(mirrored)).toBe(EXIT_NOT_CHECKED);
  });

  it('every declared hostSuiteRatchet names a file that EXISTS', () => {
    // A typo'd or moved path is indistinguishable from a real ratchet at the point of the
    // skip — the router never opens the file. This is the cheapest phantom to create.
    for (const g of guards.filter((x) => x.hostSuiteRatchet)) {
      expect(
        () => readFileSync(resolve(REPO_ROOT, g.hostSuiteRatchet as string), 'utf8'),
        `${g.script} declares hostSuiteRatchet '${g.hostSuiteRatchet}', which does not exist`,
      ).not.toThrow();
    }
  });

  it('every declared hostSuiteRatchet lives in the host workspace, so its `test` task really runs it', () => {
    // Deferring to `@papercusp/operator-core :: test` is only sound if the ratchet is INSIDE
    // that suite. A ratchet in another workspace is never executed by the task being deferred
    // to, which is the same hole wearing a declaration.
    for (const g of guards.filter((x) => x.hostSuiteRatchet)) {
      expect(
        g.hostSuiteRatchet,
        `${g.script}'s ratchet must sit inside packages/operator-core so operator-core's ` +
          'own `test` task executes it',
      ).toMatch(/^packages\/operator-core\//);
    }
  });

  it('every declared hostSuiteRatchet actually RE-RUNS the invariant it vouches for', () => {
    // The substantive check: the named file must reference the guard's own detector, either
    // by being the vitest file the guard script targets, or by exercising the .mjs it runs.
    // A file that merely sits in the suite vouches for nothing.
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    for (const g of guards.filter((x) => x.hostSuiteRatchet)) {
      const command = pkg.scripts?.[g.script] ?? '';
      const ratchetPath = g.hostSuiteRatchet as string;
      const body = readFileSync(resolve(REPO_ROOT, ratchetPath), 'utf8');
      // WI-38089: match a `.ts`/`.mts`/`.cjs` detector too, not just `.mjs`. The narrower regex
      // failed CLOSED (a legitimate ratchet over a tsx detector could not be declared at all, and
      // the only way past it was to DROP the ratchet and pay the guard on every edit) — but
      // failing closed here pushes toward the wasteful direction for an expensive guard, so the
      // extension list, not the assertion, is what widens. The requirement is unchanged: the
      // ratchet file must still reference the same detector by name.
      const detector = /([\w-]+\.(?:mjs|cjs|mts|ts))/.exec(command)?.[1] ?? null;

      // Case 1: the guard script IS this vitest file, so the host suite runs it by construction.
      const isOwnVitestTarget =
        /vitest/.test(command) && ratchetPath.endsWith(command.trim().split(/\s+/).pop() ?? '\0');
      // Case 2: a standalone detector — the ratchet must exercise that same .mjs.
      const exercisesDetector = detector !== null && body.includes(detector);

      expect(
        isOwnVitestTarget || exercisesDetector,
        `${g.script} defers to the host suite on the strength of ${ratchetPath}, but that file ` +
          `neither is the vitest target of \`${command}\` nor references ` +
          `${detector ?? '(no .mjs detector found in the command)'}. Either point it at a file ` +
          'that really re-runs the invariant, or DROP the hostSuiteRatchet declaration so the ' +
          'guard attaches unconditionally (the fail-safe direction).',
      ).toBe(true);
    }
  });
});

describe('repo-wide guards survive a change that maps to ZERO workspaces (EI-19454727576364875)', () => {
  /**
   * The regression: an `if (!affected.length) { … process.exit(0) }` used to sit 46 lines ABOVE
   * the REPO_WIDE_INVARIANT_GUARDS loop, so the loop was unreachable whenever the changed paths
   * routed to no workspace. That defeated the mechanism in precisely the case it exists for — a
   * guard is keyed on `appliesTo(changedFile)` so it keeps running when its host workspace is not
   * affected, and a root-level edit (package.json, tsconfig.base.json, the lockfile) is both the
   * likeliest to break something repo-wide and the likeliest to route nowhere.
   *
   * Measured before the fix: `--changed-paths package.json` printed
   * `status=passed tasks=0 reason=no-affected-workspaces` while a guard registered with
   * `appliesTo: (f) => f === 'package.json'` sat there matching and never ran. It presented as
   * GREEN, which is the expensive direction — `tasks=0 … status=passed` is indistinguishable from
   * "nothing needed checking".
   */
  const UNROUTED_PATH = 'package.json';

  it('selects zero workspaces for the probe path (else this test proves nothing)', () => {
    // The vacuity check, first and deliberately. Every assertion below is only meaningful while
    // the probe path really does route nowhere; if package.json is ever wired to a workspace,
    // these would keep passing for an entirely different reason and quietly stop guarding.
    const out = dryTasks(UNROUTED_PATH);
    expect(
      out,
      `${UNROUTED_PATH} now routes to a workspace, so it no longer exercises the zero-workspace ` +
        'path. Point this probe at a path that still routes nowhere — do not delete the test.',
    ).toContain('Affected workspaces (0)');
  });

  it('still attaches and runs repo-wide guards', () => {
    const out = dryTasks(UNROUTED_PATH);

    expect(
      out,
      'A change routing to no workspace exited before the repo-wide invariant guard loop, so ' +
        'every registered guard was skipped. Do NOT reintroduce an early `!affected.length` exit ' +
        'above that loop — let the single `!tasks.length` exit below it handle the empty case.',
    ).toContain('repo-wide invariant guard');

    expect(
      out,
      'The run reported reason=no-affected-workspaces even though guards matched the changed ' +
        'paths — the early-exit regression is back.',
    ).not.toContain('reason=no-affected-workspaces');
  });

  it('reports the genuinely-empty case without claiming guards ran', () => {
    // The other half: when NOTHING matches, the run must still say so honestly rather than
    // inventing work. Asserted on the reason token, not the prose, so wording can change.
    const out = dryTasks(UNROUTED_PATH);
    const tasks = Number(out.match(/AFFECTED_TESTS_RESULT[^\n]*\btasks=(\d+)/)?.[1] ?? '-1');
    expect(
      tasks,
      'Could not read a task count from AFFECTED_TESTS_RESULT — the probe cannot conclude ' +
        'anything about whether guards attached.',
    ).toBeGreaterThan(0);
  });
});

describe('affected-tests: --print-affected includes repo-wide guards (EI-20099180021812549)', () => {
  it('keeps AFFECTED_WS lines and emits machine-readable AFFECTED_GUARD lines', () => {
    // WI-10005544: graph suggestions (P-008) add workspaces from the COMMITTED dependency
    // snapshot, which counts only while it is under 24h old and its importer hashes still
    // match. With suggestions on, this file's closure moved between ['@papercusp/web'] and
    // [web, operator-ui, operator-vite] (via GoalDetailPanel -> HudView -> the vite route and
    // the operator-ui surface) depending on snapshot age alone. This case asserts the
    // print-affected surface and the package-graph baseline, so pin suggestions off.
    // Suggestion behaviour has its own suite: affected-tests-graph-suggestions.test.ts.
    const out = printAffected('apps/operator/app/adv/hud/GoalSessionsRail.tsx', {
      ...process.env,
      PAPERCUSP_AFFECTED_GRAPH_SUGGESTIONS: '0',
    });
    const lines = out.split('\n').filter(Boolean);

    expect(lines.filter((line) => line.startsWith('AFFECTED_WS\t'))).toEqual(['AFFECTED_WS\t@papercusp/web']);
    expect(lines.some((line) => line.startsWith('AFFECTED_GUARD\t@papercusp/operator-core\tlint:chunk-safe\t'))).toBe(true);
    const guardLine = lines.find((line) => line.startsWith('AFFECTED_GUARD\t@papercusp/operator-core\tlint:chunk-safe\t'));
    expect(guardLine).toBe(
      'AFFECTED_GUARD\t@papercusp/operator-core\tlint:chunk-safe\t' +
        'npm run --silent --workspace @papercusp/operator-core lint:chunk-safe',
    );
    const forwardedGuardLine = lines.find((line) =>
      line.startsWith('AFFECTED_GUARD\t@papercusp/operator-core\tlint:vimock-export-strands\t'),
    );
    expect(forwardedGuardLine).toContain(
      'npm run --silent --workspace @papercusp/operator-core lint:vimock-export-strands -- ' +
        '--files=apps/operator/app/adv/hud/GoalSessionsRail.tsx --base ',
    );
    expect(out).not.toContain('AFFECTED_TESTS_RESULT');
    expect(out).not.toContain('(repo-wide invariant guard:');
  });

  it('reports guards even when the changed path maps to zero workspaces', () => {
    const out = printAffected('package.json');
    const lines = out.split('\n').filter(Boolean);

    expect(lines.filter((line) => line.startsWith('AFFECTED_WS\t'))).toEqual([]);
    expect(lines.some((line) => line.startsWith('AFFECTED_GUARD\t@papercusp/operator-core\tlint:guard-reachability\t'))).toBe(true);
    const guardLine = lines.find((line) => line.startsWith('AFFECTED_GUARD\t@papercusp/operator-core\tlint:guard-reachability\t'));
    expect(guardLine).toBe(
      'AFFECTED_GUARD\t@papercusp/operator-core\tlint:guard-reachability\t' +
        'npm run --silent --workspace @papercusp/operator-core lint:guard-reachability',
    );
    expect(out).not.toContain('AFFECTED_TESTS_RESULT');
  });
});
