/**
 * affected-tests-repo-wide-invariant-guards.spawn-and-import.test.ts — spawn / import / bundle / liveness guards.
 *
 * One shard of the affected-tests-repo-wide-invariant-guards*.test.ts family (split by
 * green-main-cycle-time-2026-10-08 P-004 so the gate can run the shards in
 * parallel). The suite's rationale, probe helpers and fixture constants live in
 * ./affected-tests-repo-wide-invariant-guards.shared.ts — read its header before adding a section here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  HOST_WORKSPACE,
  REPO_ROOT,
  dryTasks,
} from './affected-tests-repo-wide-invariant-guards.shared';


/**
 * WI-7025 — the `.mjs` enrollment guard must travel with every TS importer it scans.
 *
 * `check-unenrolled-mjs-imports.test.ts` is a real-tree ratchet, but it lives in
 * operator-core. Without the repo-wide registration, an import added in another workspace
 * stays invisible to `test:affected` until the later fleet typecheck. These probes pin both
 * directions of the routing predicate and the three non-TS inputs that can change its verdict.
 */
describe('affected-tests: detached-spawn tree guard (WI-10002061)', () => {
  const SCRIPT = 'lint:no-unenrolled-spawn';
  const TASK = `${HOST_WORKSPACE} :: ${SCRIPT}`;

  it('attaches the real-tree scan for source outside its host workspace', () => {
    expect(dryTasks('packages/backup/src/hook.ts')).toContain(TASK);
    expect(dryTasks('apps/operator/lib/release/deploy-cli.ts')).toContain(TASK);
  });

  it('attaches for its own detector and routing configuration', () => {
    expect(dryTasks('scripts/check-no-unenrolled-detached-spawn.mjs')).toContain(TASK);
    expect(dryTasks('scripts/affected-tests.mjs')).toContain(TASK);
  });

  it('does not attach to a file the tree scan excludes', () => {
    expect(dryTasks('apps/operator/docs/nuqs-audit-2026-05-11.md')).not.toContain(TASK);
    expect(dryTasks('packages/backup/src/hook.test.ts')).not.toContain(TASK);
  });

  it('keeps the host script pointed at the real-tree checker', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.[SCRIPT]).toContain('check-no-unenrolled-detached-spawn.mjs');
  });
});

/**
 * WI-10005282 — `lint:no-eager-execfile-promisify` scans the whole tracked tree, but its only
 * blocking runner was a GitHub Actions job that failed on every run, so 14 offenders landed
 * unseen. These probes pin the registration that puts it on the gate's affected-suite path,
 * including its `.mjs` half (the guard scans .ts, .mjs and .cjs).
 */
describe('affected-tests: eager execFile promisify guard (WI-10005282)', () => {
  const SCRIPT = 'lint:no-eager-execfile-promisify';
  const TASK = `${HOST_WORKSPACE} :: ${SCRIPT}`;

  it('attaches the real-tree scan for .ts and .mjs source outside its host workspace', () => {
    expect(dryTasks('libs/test-config/src/dedicated-native-pg.ts')).toContain(TASK);
    expect(dryTasks('apps/operator/lib/mcp-proxy/watchdog.mjs')).toContain(TASK);
  });

  it('attaches for its own detector and routing configuration', () => {
    expect(dryTasks('scripts/check-no-eager-execfile-promisify.mjs')).toContain(TASK);
    expect(dryTasks('scripts/affected-tests.mjs')).toContain(TASK);
  });

  it('does not attach to a file the tree scan excludes', () => {
    expect(dryTasks('apps/operator/docs/nuqs-audit-2026-05-11.md')).not.toContain(TASK);
    expect(dryTasks('packages/backup/src/hook.test.ts')).not.toContain(TASK);
  });

  it('keeps the host script pointed at the real-tree checker', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.[SCRIPT]).toContain('check-no-eager-execfile-promisify.mjs');
  });
});

describe('affected-tests: real host bundle guard (EI-24368307678871025)', () => {
  const SCRIPT = 'lint:host-bundle-builds';
  const TASK = `${HOST_WORKSPACE} :: ${SCRIPT}`;

  it('runs for cross-workspace host imports and operator-core exports', () => {
    expect(dryTasks('apps/operator/lib/release/deploy-cli.ts')).toContain(TASK);
    expect(dryTasks('packages/operator-core/lib/blueprint/package-resource-receipts.ts')).toContain(TASK);
  });

  it('runs when the bundle recipe or routing changes, but skips test-only edits', () => {
    expect(dryTasks('apps/operator/bin/bundle-host.sh')).toContain(TASK);
    expect(dryTasks('scripts/affected-tests.mjs')).toContain(TASK);
    expect(dryTasks('apps/operator/lib/release/deploy.test.ts')).not.toContain(TASK);
  });

  it('resolves the real bundle check from its selected workspace', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.[SCRIPT]).toContain('check-host-bundle-builds.mjs');
  });
});

/**
 * WI-6554700010009310 (perf audit 2026-10-12 P-010) — the operator-vite client bundle budget
 * ran only in the GitHub workflow, so the green-checkpoint gate never measured it. A leak into
 * the eager bundle can arrive through any source the SPA reaches (EI-13213 came in through a
 * relative import inside operator-core), so the guard must attach far outside operator-vite.
 */
describe('affected-tests: client bundle budget guard (P-010)', () => {
  const SCRIPT = 'lint:bundle-budget';
  const TASK = `${HOST_WORKSPACE} :: ${SCRIPT}`;

  // Each dryTasks probe is a full affected-tests CLI start (memoised per file), so the
  // operator-core / apps/operator paths below reuse the host-bundle section's probes and
  // only two probes are new.
  it('runs for SPA source and for client-reachable source in other workspaces', () => {
    expect(dryTasks('apps/operator-vite/src/main.tsx')).toContain(TASK);
    expect(dryTasks('packages/operator-core/lib/blueprint/package-resource-receipts.ts')).toContain(TASK);
    expect(dryTasks('apps/operator/lib/release/deploy-cli.ts')).toContain(TASK);
  });

  it('runs when the evaluator or routing changes, but skips test-only edits', () => {
    expect(dryTasks('scripts/lib/bundle-budget.mjs')).toContain(TASK);
    expect(dryTasks('scripts/affected-tests.mjs')).toContain(TASK);
    expect(dryTasks('apps/operator/lib/release/deploy.test.ts')).not.toContain(TASK);
  });

  it('resolves the real budget check from its selected workspace', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.[SCRIPT]).toContain('check-bundle-budget.mjs');
  });
});

describe('affected-tests: unenrolled .mjs import guard (WI-7025)', () => {
  const SCRIPT = 'lint:no-unenrolled-mjs-imports';
  const TASK = `${HOST_WORKSPACE} :: ${SCRIPT}`;
  const OUTSIDE_TS = 'apps/operator/lib/release/deploy-cli.ts';
  const INSIDE_TS = 'packages/operator-core/lib/terminal-spawn.ts';
  const NON_SOURCE = 'apps/operator/docs/nuqs-audit-2026-05-11.md';
  const DECLARATIONS_CONFIG = 'tsconfig.declarations.json';

  it('attaches for a TS change OUTSIDE the host workspace', () => {
    expect(dryTasks(OUTSIDE_TS)).toContain(TASK);
  });

  it('does NOT double-run when the host workspace is already affected', () => {
    const out = dryTasks(INSIDE_TS);
    expect(out).toContain(`${HOST_WORKSPACE} :: test`);
    expect(out).not.toContain(TASK);
  });

  it('attaches when the declarations config changes', () => {
    expect(dryTasks(DECLARATIONS_CONFIG)).toContain(TASK);
  });

  it('does NOT attach for a non-source path', () => {
    expect(dryTasks(NON_SOURCE)).not.toContain(TASK);
  });

  it('keeps the guard script defined and pointed at the detector', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.[SCRIPT]).toBeTruthy();
    expect(pkg.scripts?.[SCRIPT]).toContain('check-unenrolled-mjs-imports.mjs');
    expect(pkg.scripts?.[SCRIPT]).not.toContain('vitest');
  });
});

/**
 * EI-20822558150340173 / D-046 — the same class again, on the registry that decides what
 * every agent's PreToolUse gate ENFORCES.
 *
 * `ALL_PAIRS` has two projections. The `CLAUDE.md` routing table has had a `--check` gate
 * since it shipped and stayed correct. The `harness_shared.bash_tool_substitutions` rows had
 * NO automatic caller of any kind — `seedSubstitutionRegistry()` is reachable only from the
 * manual `npm run seed:substitutions` — so a pair edit changed nothing about enforcement,
 * indefinitely, while the unit tests, `gen:tool-routing:check`, typecheck and git-sync all
 * reported success. Measured: `policy-violation:unsafe-dependency-install` was widened in
 * code on 2026-08-14 and the live row still carried the narrower pattern four days later.
 *
 * Both directions are asserted, for the reason the migration-lint block above gives: a
 * registration that attaches to EVERYTHING fails just as surely as one that attaches to
 * nothing — it spends every agent's edit budget on a DB round-trip that cannot find anything.
 */
describe('affected-tests: substitution registry drift guard (D-046)', () => {
  const SEED_SCRIPT = 'seed:substitutions:check';
  const SEED_TASK = `${HOST_WORKSPACE} :: ${SEED_SCRIPT}`;
  const PAIRS_DIR = 'packages/operator-core/lib/bash-substitution/pairs';
  const FIXTURES_DIR = 'packages/operator-core/lib/bash-substitution/fixtures';

  it('attaches for a change to a PAIR — the edit that silently rots the live rows', () => {
    const out = dryTasks(`${PAIRS_DIR}/dependency-install.ts`);
    expect(
      out,
      'a pair edit is the ONLY thing that can put the seeded registry out of date; if this ' +
        `guard is not attached here it is attached nowhere useful. Task list was:\n${out}`,
    ).toContain(SEED_TASK);
  });

  it('attaches for a re-frozen FIXTURE, which moves the recomputed verdict', () => {
    // The verdict stored on each row is recomputed FROM the fixture sample, so re-freezing
    // a sample drifts a seeded field without touching any pair.
    const out = dryTasks(`${FIXTURES_DIR}/deps.unsafe-install.sample.json`);
    expect(out).toContain(SEED_TASK);
  });

  it('STILL attaches when the host workspace is affected, because nothing in that suite re-runs it', () => {
    // A pair lives inside operator-core, so its own suite is always selected too. The guard
    // declares no hostSuiteRatchet, and correctly so: operator-core's vitest run never
    // queries Postgres, so it cannot substitute for a check whose entire subject is the
    // difference between the pairs and the live rows.
    const out = dryTasks(`${PAIRS_DIR}/dependency-install.ts`);
    expect(out).toContain(`${HOST_WORKSPACE} :: test`);
    expect(
      out,
      'the host suite does not read the database, so deferring to it would be silent ' +
        'coverage loss rather than a saved duplicate run',
    ).toContain(SEED_TASK);
  });

  it('does NOT attach for a bash-substitution file that cannot drift a row', () => {
    // The discriminating case, and the reason `appliesTo` is not the whole module: the
    // matcher, the report and the census are all downstream of the seeded row rather than
    // inputs to it. Attaching here would put a DB round-trip on edits that provably cannot
    // produce a finding.
    const out = dryTasks('packages/operator-core/lib/bash-substitution/match.ts');
    expect(
      out,
      'only the pairs and their frozen fixtures are seeded from; a change to the matcher ' +
        'cannot make the registry stale',
    ).not.toContain(SEED_TASK);
  });

  it('keeps the guard script defined on the HOST workspace, so the attachment cannot silently no-op', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(
      pkg.scripts?.[SEED_SCRIPT],
      `${HOST_WORKSPACE} must define "${SEED_SCRIPT}". The router only builds a task when the ` +
        'script exists on the HOST workspace, so declaring it only in the ROOT package.json ' +
        'leaves the registration attaching nothing while every probe still looks healthy.',
    ).toBeTruthy();
    expect(pkg.scripts?.[SEED_SCRIPT]).toContain('seed-substitution-registry.ts');
    expect(
      pkg.scripts?.[SEED_SCRIPT],
      'must invoke --check; without it the script SEEDS, which would make the guard write to ' +
        'the live enforcement rows it is meant to merely police',
    ).toContain('--check');
  });
});

/**
 * EI-19453217565223331 — `positions.deployed` is git ancestry, while process
 * liveness requires `serving.startedSinceCodeChange`.  The detector scans the
 * whole production tree, so routing must fire for an edit outside its host
 * workspace and must defer to this in-suite ratchet when operator-core itself
 * is already selected.
 */
describe('affected-tests: deployed-liveness read guard (EI-19453217565223331)', () => {
  const SCRIPT = 'lint:no-deployed-liveness-read';
  const TASK = `${HOST_WORKSPACE} :: ${SCRIPT}`;
  const OUTSIDE_PATH = 'apps/operator/lib/release/deploy-cli.ts';
  const INSIDE_PATH = 'packages/operator-core/lib/git-pipeline-position.ts';
  const UNMATCHED_PATH = 'apps/operator/app/_brand-primitives.css';

  it('attaches for a production TS change outside operator-core', () => {
    expect(
      dryTasks(OUTSIDE_PATH),
      `${OUTSIDE_PATH} is in the detector scan population but routes to @papercusp/web; ` +
        'without the repo-wide attachment a new ungrounded reader there gets no local signal',
    ).toContain(TASK);
  });

  it('defers to the host suite when operator-core is affected', () => {
    const out = dryTasks(INSIDE_PATH);
    expect(out).toContain(`${HOST_WORKSPACE} :: test`);
    expect(
      out,
      'the in-suite ratchet executes findOffenders() over the real tree, so queueing the same ' +
        'detector task would only duplicate work',
    ).not.toContain(TASK);
  });

  it('does not attach for a path outside the detector population', () => {
    const out = dryTasks(UNMATCHED_PATH);
    expect(out).not.toContain(TASK);
    expect(out).not.toContain(`${HOST_WORKSPACE} :: test`);
  });

  it('keeps the guard script declared on the host workspace', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.[SCRIPT]).toContain('check-no-deployed-liveness-read.mjs');
  });
});
