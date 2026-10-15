/**
 * affected-tests-repo-wide-invariant-guards.lint-guards.test.ts — repo-wide lint guards (OKF, green-checkpoint tag, mug/kettle, required-field strands, declarations).
 *
 * One shard of the affected-tests-repo-wide-invariant-guards*.test.ts family (split by
 * green-main-cycle-time-2026-10-08 P-004 so the gate can run the shards in
 * parallel). The suite's rationale, probe helpers and fixture constants live in
 * ./affected-tests-repo-wide-invariant-guards.shared.ts — read its header before adding a section here.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OKF_SCAN_ROOTS, isOkfScannedFile } from '../../../../scripts/check-okf-conformance.mjs';
import { GC_TAG_SOURCE_ROOTS } from '../../../../scripts/check-green-checkpoint-tag.mjs';
import {
  GC_TAG_OUTSIDE_PATH,
  GC_TAG_SCRIPT,
  GC_TAG_TASK,
  GC_TAG_UNSCANNED_PATH,
  HOST_WORKSPACE,
  MK_MARKDOWN_PATH,
  MK_OUTSIDE_TS_PATH,
  MK_TEMPLATE_YAML_PATH,
  MK_UNMATCHED_PATH,
  MUG_KETTLE_SCRIPT,
  MUG_KETTLE_TASK,
  OKF_SCRIPT,
  OKF_TASK,
  REPO_ROOT,
  RFS_OUTSIDE_TS_PATH,
  RFS_SCRIPT,
  RFS_TASK,
  RFS_UNMATCHED_PATH,
  VIMOCK_GUARD_TASK,
  dryTaskLine,
  dryTasks,
  pinnedBase,
  printAffected,
  realOkfFileUnder,
  someSubmodulePath,
} from './affected-tests-repo-wide-invariant-guards.shared';


describe('affected-tests: OKF frontmatter conformance guard (WI-35930)', () => {
  it.each((OKF_SCAN_ROOTS as string[]).map((root) => [root]))(
    'enforces the lint for a change under scanned root %s',
    (root: string) => {
      const probe = realOkfFileUnder(root);
      if (!probe) {
        // Nothing tracked under this root in THIS checkout (submodule-less gate tree).
        expect(true).toBe(true);
        return;
      }
      const out = dryTasks(probe);
      const reached = out.includes(OKF_TASK) || out.includes(`${HOST_WORKSPACE} :: test`);
      expect(
        reached,
        `the lint SCANS ${root} (probe: ${probe}), so a change there must reach it — via ` +
          `"${OKF_TASK}" or via "${HOST_WORKSPACE} :: test". This case is GENERATED from the ` +
          "lint's own exported OKF_SCAN_ROOTS: if you widened the scan there and did not " +
          'mirror it into OKF_SCAN_ROOTS in scripts/affected-tests.mjs, the guard silently ' +
          `stopped enforcing that root. Task list was:\n${out}`,
      ).toBe(true);
    },
  );

  it('does NOT attach for a DOT-PATH inside a scanned root', () => {
    // The discrimination that shaped the whole lint (plan D-001): this file IS
    // git-tracked and `isInsightDoc()` accepts it, but Astro's content loader never
    // sees it, so the lint deliberately excludes it. Routing on it would spend every
    // agent's edit budget on a file the lint refuses to judge.
    const dotPath = `${OKF_SCAN_ROOTS[0]}.papercusp/memory/raw.md`;
    expect(
      isOkfScannedFile(dotPath),
      'precondition: the lint itself must decline this path, or this case is testing ' + 'the wrong thing',
    ).toBe(false);
    expect(
      dryTasks(dotPath),
      `${dotPath} is excluded from the SCAN, so attaching the guard for it could never ` + 'produce a finding',
    ).not.toContain(OKF_TASK);
  });

  it('does NOT attach for a file outside every scanned root', () => {
    // Same extension family, different tree — a prefix-free `endsWith('.mjs'/'.md')`
    // rule would over-fire here.
    const out = dryTasks('astro.config.mjs');
    expect(
      out,
      'only the two corpus roots are scanned, so a file elsewhere cannot violate the ' + 'invariant',
    ).not.toContain(OKF_TASK);
  });

  it('keeps the guard script defined on the HOST workspace, so it cannot silently no-op', () => {
    // The exact trap WI-9573 fell into: the router `continue`s when the host workspace
    // does not define the script, producing a registry entry that attaches NOTHING and
    // looks, from every output, like success. Defining it only in the ROOT
    // package.json is not enough.
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(
      pkg.scripts?.[OKF_SCRIPT],
      `${HOST_WORKSPACE} must define "${OKF_SCRIPT}" — the router only builds a task ` +
        'when the script exists on the HOST workspace.',
    ).toBeTruthy();
    expect(pkg.scripts?.[OKF_SCRIPT]).toContain('check-okf-conformance.mjs');
  });

  it('keeps the in-suite ratchet, which covers the half this attachment deliberately skips', () => {
    // When operator-core is itself affected the router skips the narrow task, on the
    // assumption the workspace suite contains the check. For a standalone SCRIPT that
    // assumption is false, so the coverage of an operator-core-affecting change rests
    // entirely on this file. Deleting it would remove that half silently — nothing
    // would fail, the guard would just stop covering the code-written pack corpus.
    expect(
      readFileSync(resolve(REPO_ROOT, 'packages/operator-core/lib/okf-conformance-guard.test.ts'), 'utf8'),
      'the in-suite OKF ratchet must exist; the narrow task above does not run when ' +
        'operator-core is independently affected',
    ).toContain('check-okf-conformance.mjs');
  });
});

describe('affected-tests: green-checkpoint tag guard (WI-37605)', () => {
  /** A REAL tracked TS file under `root`, or null. See the MIRROR test for why it must be real. */
  function realTsFileUnder(root: string): string | null {
    const res = spawnSync('git', ['ls-files', '--recurse-submodules', root], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (res.status !== 0) return null;
    // WI-10004176: drop index entries a plain `rm` left behind until git-sync commits it.
    return (res.stdout ?? '').split('\n').filter((f) => existsSync(resolve(REPO_ROOT, f))).find((f) => /\.[cm]?tsx?$/.test(f)) ?? null;
  }

  it('attaches for a TS change outside the host workspace but inside a scanned root', () => {
    expect(
      dryTasks(GC_TAG_OUTSIDE_PATH),
      `${GC_TAG_OUTSIDE_PATH} is inside the guard's scanned roots but routes to @papercusp/web, ` +
        'so without this attachment a hardcoded production tag there gets ZERO local signal and ' +
        'first appears as an impostor line in a verdict log someone is triaging under pressure',
    ).toContain(GC_TAG_TASK);
  });

  it('does NOT double-run it when the host workspace is already affected', () => {
    expect(dryTasks('packages/operator-core/lib/harness/routines/release-actions.ts')).not.toContain(GC_TAG_TASK);
  });

  it('does NOT attach for a TS file outside every scanned root', () => {
    expect(
      dryTasks(GC_TAG_UNSCANNED_PATH),
      'precision is part of the contract — over-firing spends every agent edit for a finding ' +
        'that is impossible by construction',
    ).not.toContain(GC_TAG_TASK);
  });

  it('MIRROR: every scanned root the real guard declares is actually COVERED', () => {
    // The router hardcodes its own copy of GC_TAG_SOURCE_ROOTS. Asserting BEHAVIOUR per root
    // (rather than list equality) also catches a root that is mirrored correctly but whose files
    // route somewhere the attachment never fires from.
    //
    // ⚠ TWO TRAPS, both of which the first version of this test fell into:
    //  1. The probe must be a REAL TRACKED FILE. The router maps a path to a workspace by PACKAGE
    //     DIRECTORY, so a synthesized `<root>/__probe__.ts` matches no package, selects nothing,
    //     and exits BEFORE the guard loop (WI-7013) — reading as "not wired" when the wiring is
    //     fine. The partial-index block above documents this exact false negative; this test
    //     reproduced it anyway, which is the argument for keeping the warning where it is.
    //  2. "Covered" is a DISJUNCTION, not "attaches". For the root that IS inside the host
    //     workspace, the attachment is deliberately SKIPPED to avoid double-running — that root
    //     is covered by operator-core's own suite instead. Asserting `toContain` for every root
    //     would therefore contradict the no-double-run rule the sibling tests pin.
    for (const root of GC_TAG_SOURCE_ROOTS) {
      const probe = realTsFileUnder(root);
      if (!probe) continue; // gate-shaped checkouts carry 0/39 submodules (WI-6776) — skip, never red
      const out = dryTasks(probe);
      expect(
        out.includes(GC_TAG_TASK) || out.includes(HOST_WORKSPACE),
        `root "${root}" is declared by the guard but a real file there (${probe}) neither ` +
          'attaches the guard task nor selects the host workspace whose suite runs it — so edits ' +
          'under that root get no enforcement at all',
      ).toBe(true);
    }
  });

  it('keeps the guard script DEFINED, so the registration cannot be silently inert', () => {
    // The specific false green this catches (WI-37454/WI-37445): affected-tests.mjs skips a
    // registered-but-undeclared guard with a bare `continue`, so the guard runs NOWHERE while
    // lint:guard-reachability still credits it as fully enforced.
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(
      pkg.scripts?.[GC_TAG_SCRIPT],
      `${HOST_WORKSPACE} must define "${GC_TAG_SCRIPT}" or the attachment is inert`,
    ).toBeTruthy();
    // Pointed at the SCRIPT, not the vitest file: the narrow task only needs the ratchet.
    expect(pkg.scripts?.[GC_TAG_SCRIPT]).toContain('check-green-checkpoint-tag.mjs');
  });
});

describe('affected-tests: ungated mug/kettle guard (EI-20032324229208320)', () => {
  it('attaches for a TS change outside the host workspace', () => {
    expect(
      dryTasks(MK_OUTSIDE_TS_PATH),
      `${MK_OUTSIDE_TS_PATH} routes to @papercusp/web, so without this attachment a NEW ` +
        'mug/kettle entry point added there gets ZERO local signal — which is the whole ' +
        'point of a repo-wide guard: nobody knows in advance which file grows the next door',
    ).toContain(MUG_KETTLE_TASK);
  });

  // NOTE — deliberately NO "does not double-run when the host workspace is affected" case here,
  // unlike the sibling blocks above. That behaviour is MID-CHANGE in the working tree
  // (EI-20026978310669562): the host-suite skip is moving from assumed to DECLARED via
  // `hostSuiteRatchet`, so a guard that names no in-suite ratchet will attach
  // unconditionally — the fail-safe direction. This guard names none (operator-core's suite
  // contains nothing that re-runs the mug/kettle census), so under the new rule it SHOULD
  // attach even inside the host workspace, which is the opposite of what the siblings assert.
  // Pinning either polarity here would encode a semantic that is actively being inverted, so
  // this block asserts only what is TRUE UNDER BOTH: the predicate and the wiring.

  it('attaches for a MARKDOWN change — a new mug role prompt is a real re-introduction path', () => {
    // The `.md` half of the predicate is the easiest to drop in a refactor and the hardest to
    // miss the consequences of: blueprint prompts are a census category, so a quiet new mug
    // role prompt is exactly the shape this guard exists to catch.
    expect(dryTasks(MK_MARKDOWN_PATH)).toContain(MUG_KETTLE_TASK);
  });

  it('attaches for YAML agentic-template guidance, not only code and Markdown', () => {
    expect(dryTasks(MK_TEMPLATE_YAML_PATH)).toContain(MUG_KETTLE_TASK);
  });

  it('does NOT attach for a change the predicate cannot match', () => {
    const out = dryTasks(MK_UNMATCHED_PATH);
    // ⚠ This assertion is only about the PREDICATE if the double-run branch cannot have fired
    // first. The guard loop tests, in order: inert -> excludes -> already-queued -> appliesTo.
    // Pinning that the host workspace is absent is what makes this a predicate test rather
    // than a test that passes for an unrelated reason. A `.ts` under libs/flags looks like a
    // negative case but is NOT one — it pulls operator-core in through the dep graph and is
    // skipped as a double-run, with the predicate never consulted.
    expect(
      out,
      'must not be excluded via the already-queued branch, or this proves nothing about appliesTo',
    ).not.toContain(`${HOST_WORKSPACE} :: test`);
    expect(
      out,
      'every agent pays for this guard on every edit; attaching it to a stylesheet spends ' +
        'that budget for a finding that is impossible by construction',
    ).not.toContain(MUG_KETTLE_TASK);
  });

  it('keeps the guard script DEFINED, so the registration cannot be silently inert', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(
      pkg.scripts?.[MUG_KETTLE_SCRIPT],
      `${HOST_WORKSPACE} must define "${MUG_KETTLE_SCRIPT}" or the attachment is inert — ` +
        'affected-tests.mjs skips a registered-but-undeclared guard with a bare `continue`',
    ).toBeTruthy();
    expect(pkg.scripts?.[MUG_KETTLE_SCRIPT]).toContain('check-ungated-mug-kettle.mjs');
  });
});

describe('affected-tests: required-field-strands guard (WI-38401)', () => {
  it('attaches for a TS change outside the host workspace', () => {
    expect(
      dryTasks(RFS_OUTSIDE_TS_PATH),
      `${RFS_OUTSIDE_TS_PATH} routes to @papercusp/web. A required field added to an ` +
        'exported interface strands its DEPENDENTS, which no workspace selection and no ' +
        'scoped typecheck can reach — so the guard must attach on the changed path itself',
    ).toContain(RFS_TASK);
  });

  it('forwards the authoritative base and exact triggering paths so git-sync cannot make it vacuous', () => {
    const { base, probeRef: baseRef } = pinnedBase('HEAD^');
    const out = dryTasks(RFS_OUTSIDE_TS_PATH, baseRef);
    expect(
      out,
      'a post-git-sync run needs the before-image and exact scope; --files alone still ' +
        'compares byte-identical HEAD content and exits NOT_CHECKED',
    ).toContain(`${RFS_TASK} (guard base: ${base}) ` + `(guard args: --files=${RFS_OUTSIDE_TS_PATH})`);
  });

  it('moves an E2BIG-class triggering set into a cleaned JSON response file', () => {
    // Large enough to cross affected-tests' conservative 32 KiB inline ceiling while
    // remaining below Linux's own single-argument ceiling for THIS probe's
    // --changed-paths input. The 2026-08-25 gate incident carried 5,976 distinct paths
    // and exceeded the kernel ceiling before the guard process could start.
    // Explicit changed paths are normalized and de-duplicated before forwarding. Use
    // distinct TS-shaped paths here so the fixture still models a genuinely large
    // triggering population instead of collapsing to one inline argument.
    const changedPaths = Array.from(
      { length: 1_000 },
      (_, index) => `${RFS_OUTSIDE_TS_PATH.replace(/\.ts$/, '')}-${index}.ts`,
    ).join(',');
    expect(Buffer.byteLength(changedPaths, 'utf8')).toBeGreaterThan(32 * 1024);

    const out = dryTasks(changedPaths, 'HEAD^');
    const line = dryTaskLine(out, RFS_TASK);
    const responseMatch = line.match(/\(guard args: --files-from=([^\s)]+)\)/);
    expect(
      responseMatch,
      'large scopes must keep the file population out of argv; one --files=<thousands> ' +
        'entry reproduces spawn E2BIG and aborts the whole checkpoint without a verdict',
    ).not.toBeNull();
    expect(line).not.toContain('(guard args: --files=');
    expect(existsSync(responseMatch?.[1] ?? '')).toBe(false);

    // The sibling vimock guard consumes the same exact path population. It must use the
    // same response-file transport and parser; otherwise enabling its forwarded scope
    // merely moves the historical E2BIG gate abort from one guard to the other.
    const vimockLine = dryTaskLine(out, VIMOCK_GUARD_TASK);
    const vimockResponse = vimockLine.match(/\(guard args: --files-from=([^\s)]+)\)/);
    expect(vimockResponse).not.toBeNull();
    expect(vimockLine).not.toContain('(guard args: --files=');
    expect(existsSync(vimockResponse?.[1] ?? '')).toBe(false);
  }, 120_000);

  it('attaches for a SUBMODULE ROOT path — the shape the 2026-08-12 main freeze arrived as', () => {
    const submodule = someSubmodulePath();
    expect(
      dryTasks(submodule),
      `a change inside ${submodule} reaches affected-tests.mjs only as the bare submodule ` +
        'root, so a TS-family-only appliesTo leaves every submodule-internal required-field ' +
        'addition unattached while the registration LOOKS complete',
    ).toContain(RFS_TASK);
  });

  it('does NOT attach for a non-source path outside every submodule', () => {
    // The DIFFERENTIAL that makes the case above a real test of the submodule clause: both
    // paths are non-TS, and only the submodule root attaches. Nothing but
    // `gitmodulePaths().has(f)` can tell them apart.
    const out = dryTasks(RFS_UNMATCHED_PATH);
    expect(
      out,
      'must not be skipped via the already-queued branch, or this proves nothing about appliesTo',
    ).not.toContain(`${HOST_WORKSPACE} :: ${RFS_SCRIPT}`);
    expect(out).not.toContain(RFS_TASK);
  });

  it('registers the ATTRIBUTED typecheck form for the affected-path enforcement rung', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const cmd = pkg.scripts?.[RFS_SCRIPT];
    expect(
      cmd,
      `${HOST_WORKSPACE} must define "${RFS_SCRIPT}" or the attachment is inert — ` +
        'affected-tests.mjs skips a registered-but-undeclared guard with a bare `continue`',
    ).toBeTruthy();
    expect(cmd).toContain('check-required-field-strands.mjs');
    expect(cmd).toContain('check-required-field-strands.mjs --typecheck');
  });
});

/**
 * WI-38089 — the declarations freshness guard, wired the same way.
 *
 * `generated-declarations.test.ts` execs `scripts/gen-declarations.ts --check`, comparing the
 * `.mjs` inputs declared in tsconfig.declarations.json against their committed `.d.mts`. It is a
 * vitest file inside operator-core, so it was reachable only when operator-core was otherwise
 * affected. MEASURED 2026-08-12: `--changed-paths apps/operator/scripts/psu-launcher.mjs` selected
 * `@papercusp/web` ONLY, though psu-launcher.mjs IS a declared input. Editing it without re-running
 * `npm run gen:declarations` therefore produced no local signal — test:affected green, and the
 * drift is type-only so lint:tsc is green too — and first surfaced as green-checkpoint red #9
 * (candidate cc56ee43) an hour later, against a candidate its author had long moved past.
 *
 * The `appliesTo` set is DERIVED from tsconfig.declarations.json rather than mirrored, so there is
 * no list here to keep in sync. What needs asserting instead is that the derivation still
 * DISCRIMINATES: 'attaches for a declared input' and 'does NOT attach for an undeclared .mjs' are a
 * matched pair, and the router widens to every `.mjs` if it cannot read the config — so a
 * derivation that silently stopped finding inputs fails the negative test rather than passing both.
 */
describe('affected-tests: declarations freshness guard (WI-38089)', () => {
  const DECL_SCRIPT = 'lint:declarations-fresh';
  const DECL_TASK = `${HOST_WORKSPACE} :: ${DECL_SCRIPT}`;
  /** A declared input OUTSIDE the host workspace — the measured case from the filing. */
  const OUTSIDE_INPUT = 'apps/operator/scripts/psu-launcher.mjs';
  /** A declared input INSIDE the host workspace, whose full `test` task already covers the check. */
  const INSIDE_INPUT = 'packages/operator-core/lib/model-context-budget.mjs';
  /**
   * An `.mjs` that is NOT a declared input, so it cannot cause declaration drift.
   *
   * It must ALSO route to a workspace other than operator-core, or the negative test proves
   * nothing: a root-level `scripts/*.mjs` fans out to operator-core, whose `test` task then
   * satisfies the hostSuiteRatchet and suppresses the guard for that reason instead of because the
   * path is undeclared. (Measured the hard way — `scripts/check-js-syntax.mjs` was the first
   * choice here and is itself one of the 42 declared inputs, so it asserted the opposite of what
   * it appeared to.) `apps/operator-docs` routes only to @papercupai/operator-docs.
   */
  const UNDECLARED_MJS = 'apps/operator-docs/astro.config.mjs';
  const DECL_CONFIG = 'tsconfig.declarations.json';

  function declaredInputs(): string[] {
    const raw = readFileSync(resolve(REPO_ROOT, DECL_CONFIG), 'utf8');
    return [...raw.matchAll(/"([^"\n]+\.mjs)"/g)].map((m) => m[1]);
  }

  it('keeps its premises true: both probe paths are still declared inputs, and the control is not', () => {
    const declared = declaredInputs();
    expect(
      declared.length,
      'no declared .mjs inputs found — the router would then widen to every .mjs, silently ' +
        'turning this guard into a tax on unrelated edits',
    ).toBeGreaterThan(0);
    expect(declared, `${OUTSIDE_INPUT} must remain a declared input or this suite proves nothing`).toContain(
      OUTSIDE_INPUT,
    );
    expect(declared, `${INSIDE_INPUT} must remain a declared input`).toContain(INSIDE_INPUT);
    expect(
      declared,
      `${UNDECLARED_MJS} must NOT be declared — it is the negative control that proves the ` +
        'derivation discriminates rather than matching everything',
    ).not.toContain(UNDECLARED_MJS);
  });

  it('attaches for a declared input OUTSIDE its host workspace', () => {
    const out = dryTasks(OUTSIDE_INPUT);
    expect(
      out,
      `editing ${OUTSIDE_INPUT} must run the declarations check; without it, forgetting ` +
        '`npm run gen:declarations` gets ZERO local signal (test:affected green, lint:tsc green ' +
        'because the drift is type-only) and first reds the shared gate an hour later',
    ).toContain(DECL_TASK);
  });

  it('attaches when the CONFIG itself changes, which is the missing-declaration shape', () => {
    // Adding an input without generating its `.d.mts` is a config edit, not a source edit, and
    // `--check` reports it as `missing` rather than `stale`.
    expect(dryTasks(DECL_CONFIG)).toContain(DECL_TASK);
  });

  it('attaches when a generated .d.mts is hand-edited', () => {
    const dmts = OUTSIDE_INPUT.replace(/\.mjs$/, '.d.mts');
    expect(
      dryTasks(dmts),
      'drift in the opposite direction: the committed declaration no longer matches what the ' + 'generator would emit',
    ).toContain(DECL_TASK);
  });

  it('does NOT attach for an .mjs that is not a declared input', () => {
    // Establish the control is VALID before trusting the negative: if this path selected
    // operator-core, the hostSuiteRatchet would suppress the guard and the assertion below would
    // pass without the derivation having discriminated anything at all.
    expect(
      printAffected(UNDECLARED_MJS),
      `${UNDECLARED_MJS} must not route to ${HOST_WORKSPACE}, or this test passes for the wrong ` +
        'reason (ratchet suppression, not an undeclared path)',
    ).not.toContain(`AFFECTED_WS\t${HOST_WORKSPACE}`);
    expect(
      dryTasks(UNDECLARED_MJS),
      `this is the most expensive entry in the registry (~6.1s: a tsc emit plus a 42-file ` +
        'byte-compare), so attaching it to an .mjs that cannot violate the invariant spends ' +
        "every agent's budget for no possible finding",
    ).not.toContain(DECL_TASK);
  });

  it('does NOT double-run when the host workspace is already affected', () => {
    const out = dryTasks(INSIDE_INPUT);
    expect(out, 'the host workspace should run its own suite here').toContain(`${HOST_WORKSPACE} :: test`);
    expect(
      out,
      'generated-declarations.test.ts execs the SAME --check invocation inside operator-core’s ' +
        'suite, so attaching the narrow task as well would run a 6s check twice',
    ).not.toContain(DECL_TASK);
  });

  it('keeps the guard script defined, and pointed at the CHECK rather than the vitest file', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(
      pkg.scripts?.[DECL_SCRIPT],
      `${HOST_WORKSPACE} must define "${DECL_SCRIPT}". The router only builds a task when the ` +
        'script exists, so removing it re-opens the gap silently — the run stays green and simply ' +
        'stops checking.',
    ).toBeTruthy();
    expect(pkg.scripts?.[DECL_SCRIPT]).toContain('gen-declarations');
    expect(
      pkg.scripts?.[DECL_SCRIPT],
      'must invoke --check; without it the script GENERATES declarations, which would make the ' +
        'guard mutate the tree it is meant to police',
    ).toContain('--check');
    expect(pkg.scripts?.[DECL_SCRIPT]).not.toContain('vitest');
  });
});
