/**
 * affected-tests-repo-wide-invariant-guards.schema.test.ts — schema / migration / integration-routing guards.
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
import { SOURCE_ROOTS as PARTIAL_INDEX_SOURCE_ROOTS, SCHEMA_FILE_REL as PARTIAL_INDEX_SCHEMA_FILE } from '../../../../scripts/check-partial-index-alignment.mjs';
import { SQL_DIR_REL as MIGRATION_SQL_DIR, SOURCE_ROOTS as MIGRATION_SOURCE_ROOTS } from '../../../../scripts/check-migration-forward-compat.mjs';
import {
  HOST_WORKSPACE,
  INSIDE_TS_PATH,
  PI_OUTSIDE_PATH,
  PI_SCRIPT,
  PI_TASK,
  PI_UNSCANNED_PATH,
  REPO_ROOT,
  dryTasks,
  someSubmodulePath,
} from './affected-tests-repo-wide-invariant-guards.shared';


describe('affected-tests: partial-index-alignment guard (WI-9434)', () => {
  it('attaches for a TS change outside the host workspace but inside a scanned root', () => {
    const out = dryTasks(PI_OUTSIDE_PATH);
    expect(
      out,
      `${PI_OUTSIDE_PATH} is inside the lint's scanned roots but routes to @papercusp/web, ` +
        'so without this attachment a misaligned `->>` query there gets ZERO local signal ' +
        'and first reds the shared fleet gate',
    ).toContain(PI_TASK);
  });

  /**
   * A REAL tracked TS file under `root`, or null.
   *
   * Must be a real path, not a synthesized one: the router maps a path to a workspace by
   * PACKAGE DIRECTORY, so an invented `<root>/__probe__.ts` sitting directly under
   * `libs/papercusp/packages` matches no package and selects nothing — which reads as
   * "the guard is not wired" when the wiring is fine. That false negative is what the
   * first version of this test reported.
   *
   * `--recurse-submodules` because two roots live in submodules. Gate-shaped checkouts
   * carry 0/39 submodules (WI-6776), so this returns null there and the case SKIPS rather
   * than failing — a guard test must not red the fleet gate over a checkout shape.
   */
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

  it.each(PARTIAL_INDEX_SOURCE_ROOTS.map((root) => [root]))(
    'enforces the lint for a change under scanned root %s',
    (root: string) => {
      const probe = realTsFileUnder(root);
      if (!probe) {
        // Nothing tracked under this root in THIS checkout (submodule-less gate tree).
        expect(true).toBe(true);
        return;
      }
      const out = dryTasks(probe);
      // Either form means the ratchet is reached: the narrow guard task, or the host
      // workspace's full suite (which already contains the ratchet, so attaching the
      // narrow task as well would just run it twice).
      const reached = out.includes(PI_TASK) || out.includes(`${HOST_WORKSPACE} :: test`);
      expect(
        reached,
        `the lint SCANS ${root} (probe: ${probe}), so a change there must reach its ratchet — ` +
          `via "${PI_TASK}" or via "${HOST_WORKSPACE} :: test". This case is GENERATED from the ` +
          "lint's own exported SOURCE_ROOTS: if you added a root there and did not mirror it into " +
          'PARTIAL_INDEX_SOURCE_ROOTS in scripts/affected-tests.mjs, the guard silently stopped ' +
          `enforcing that root. Task list was:\n${out}`,
      ).toBe(true);
    },
  );

  it('reaches the ratchet when the GENERATED SCHEMA changes, not just when source changes', () => {
    // The subtle case chunk-safe does not have: the schema is an INPUT to the lint, so a
    // new partial index can retroactively misalign an existing, untouched query.
    //
    // Asserted as COVERAGE, not as one mechanism — the same shape as the generated
    // per-root case above. This guard DECLARES `hostSuiteRatchet`
    // (partial-index-alignment-guard.test.ts, whose `the tree is currently aligned` case
    // execs the identical script over REPO_ROOT), so when the schema path also pulls
    // operator-core into the affected set the ratchet is reached through the host suite
    // and the narrow task is correctly skipped. Pinning `toContain(PI_TASK)` pinned the
    // MECHANISM while meaning the COVERAGE, and broke the moment an unrelated
    // dependency-graph change made operator-core affected for libs/papercusp/** paths
    // (EI-20026978310669562) — while the invariant itself never stopped being enforced.
    const out = dryTasks(PARTIAL_INDEX_SCHEMA_FILE);
    const reached = out.includes(PI_TASK) || out.includes(`${HOST_WORKSPACE} :: test`);
    expect(
      reached,
      `${PARTIAL_INDEX_SCHEMA_FILE} defines the partial indexes the lint aligns queries ` +
        'against; adding one can misalign a query nobody touched, so a schema-only change ' +
        `must still reach the ratchet — via "${PI_TASK}" or via "${HOST_WORKSPACE} :: test". ` +
        `Task list was:\n${out}`,
    ).toBe(true);
  });

  it('does NOT double-run it when the host workspace is already affected', () => {
    const out = dryTasks(INSIDE_TS_PATH);
    expect(out).toContain(`${HOST_WORKSPACE} :: test`);
    expect(
      out,
      "operator-core's suite already contains partial-index-alignment-guard.test.ts, whose " +
        'ratchet execs the same lint — attaching the narrow task too would run it twice',
    ).not.toContain(PI_TASK);
  });

  it('does NOT attach for a TS file outside every scanned root', () => {
    const out = dryTasks(PI_UNSCANNED_PATH);
    expect(
      out,
      `${PI_UNSCANNED_PATH} is outside every SOURCE_ROOT, so the lint cannot read it and ` +
        'cannot produce a finding. Unlike chunk-safe (whose enumeration IS repo-wide), ' +
        "firing here would spend every agent's edit budget for nothing.",
    ).not.toContain(PI_TASK);
  });

  it('keeps the guard script defined, and pointed at the SCRIPT rather than the vitest file', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(
      pkg.scripts?.[PI_SCRIPT],
      `${HOST_WORKSPACE} must define "${PI_SCRIPT}" — the router only builds a task when the ` +
        'script exists, so removing it re-opens the gap silently (green, and simply no longer checking)',
    ).toBeTruthy();
    // MEASURED: the standalone script is 0.57-0.60s; running the 20-test vitest file instead
    // costs 7.66s because vitest startup dominates. Every agent pays this on every matching
    // edit, so the narrow form is load-bearing, not a style preference.
    expect(
      pkg.scripts?.[PI_SCRIPT],
      'must invoke the standalone lint script; switching it to `vitest run …` would make the ' +
        'narrow task ~12x more expensive for the same ratchet',
    ).toContain('check-partial-index-alignment.mjs');
    expect(pkg.scripts?.[PI_SCRIPT]).not.toContain('vitest');
  });
});

/**
 * WI-9573 — the THIRD instance of the class, and the most expensive so far.
 *
 * Unlike the two guards above, `lint:migration-forward-compat` had NO local
 * enforcement point at all. It was invoked only by green-checkpoint
 * (apps/operator/lib/release/green-checkpoint.ts), and a `.sql` migration maps to no
 * workspace test suite — so there was no partial coverage to widen, the signal was
 * entirely absent, and a violation first surfaced as a red FLEET gate hours later,
 * blocking every agent. MEASURED 2026-08-03: it red-pinned the gate for 4 consecutive
 * runs on migrations 750/751/752/754/755, and three other sessions independently hit
 * the same wall the same day (EI-19409083906144989, EI-19407054630567497).
 *
 * The fourth test below is not ceremony — it pins the exact trap the author of this
 * guard fell into. The router silently `continue`s when the host workspace does not
 * define the script, so registering the guard while operator-core lacked
 * `lint:migration-forward-compat` produced a registry entry that attached NOTHING and
 * looked, from every output, exactly like success.
 */
describe('affected-tests: migration forward-compat guard (WI-9573)', () => {
  const FC_SCRIPT = 'lint:migration-forward-compat';
  const FC_TASK = `${HOST_WORKSPACE} :: ${FC_SCRIPT}`;
  /** A real migration, under the directory the lint itself reports scanning. */
  const MIGRATION_PATH = `${MIGRATION_SQL_DIR}/750-drop-dead-hfc-partial-indexes.sql`;
  const DRAFT_MIGRATION_PATH = `${MIGRATION_SQL_DIR}/800-adv-sessions-ended-by-signal.sql.DRAFT`;
  const SOURCE_CONSUMER_PATH = 'apps/operator/lib/release/deploy-cli.ts';

  it('attaches for a migration .sql change, which routes to no operator-core suite', () => {
    const out = dryTasks(MIGRATION_PATH);
    expect(
      out,
      `a migration at ${MIGRATION_PATH} must run the forward-compat guard. Before this ` +
        'wiring it ran ONLY inside green-checkpoint, so destructive DDL with no ' +
        'FORWARD-COMPAT acknowledgment got zero local signal and red-pinned the shared ' +
        'gate for every agent hours later.',
    ).toContain(FC_TASK);
  });

  it('attaches for a parked .DRAFT migration change, which the authoring guard must inspect', () => {
    const out = dryTasks(DRAFT_MIGRATION_PATH);
    expect(
      out,
      `a parked migration at ${DRAFT_MIGRATION_PATH} must run the forward-compat guard; ` +
        'the runner ignores it by design, but source consumers must be rejected before it is armed',
    ).toContain(FC_TASK);
  });

  it('attaches for a source consumer change in the detector source domain', () => {
    expect(MIGRATION_SOURCE_ROOTS).toContain('apps');
    const out = dryTasks(SOURCE_CONSUMER_PATH);
    expect(
      out,
      `${SOURCE_CONSUMER_PATH} is inside the detector's source domain; a source edit while a ` +
        'DRAFT migration exists must still reach the dependency guard',
    ).toContain(FC_TASK);
  });

  it('STILL attaches when the host workspace is affected, because nothing in that suite re-runs it', () => {
    // This case asserted the OPPOSITE until EI-20026978310669562, on the premise that
    // "operator-core's full suite already covers this ratchet". That premise was never
    // true for THIS guard: operator-core's suite contains
    // migration-forward-compat-authoring.test.ts, which exercises the DETECTOR against
    // synthetic `/repo/...` fixture strings and never scans the real SQL directory — so
    // deferring to the host suite ran nothing at all. The sibling guards that DO defer
    // each name a real in-suite ratchet via `hostSuiteRatchet`; this one names none, so
    // it must attach unconditionally.
    //
    // How it surfaced: declaring @papercusp/db-org et al. on operator-core made every
    // libs/papercusp/** path pull the host workspace in, which silently disabled the
    // guard for migration .sql changes — re-opening WI-9573's class from three files away.
    // The probe must satisfy BOTH halves at once, which is what makes this a real test of
    // the skip: a path that (a) MATCHES this guard's predicate — .sql under the scanned
    // migrations dir — and (b) pulls the host workspace into the affected set. A .ts path
    // (the old case's probe) satisfies only (b): the predicate cannot match it, so it
    // would pass for a reason having nothing to do with the skip branch. MIGRATION_PATH
    // satisfies both, because libs/papercusp/** now reaches operator-core through the
    // dependency graph — the very change that exposed this bug.
    const out = dryTasks(MIGRATION_PATH);
    expect(out, 'the host workspace should run its own suite here').toContain(`${HOST_WORKSPACE} :: test`);
    expect(
      out,
      'lint:migration-forward-compat declares no hostSuiteRatchet, so the host suite ' +
        'running is NOT a substitute for it — skipping here is silent coverage loss, not ' +
        `a saved duplicate scan. Task list was:\n${out}`,
    ).toContain(FC_TASK);
  });

  it('does NOT attach for a migration-looking .sql OUTSIDE the scanned migrations directory', () => {
    // The discriminating case: same extension, different directory. A prefix-free
    // `endsWith('.sql')` rule would attach here and spend every agent's edit budget
    // on a scan that cannot produce a finding.
    const out = dryTasks('apps/operator/docs/examples/999-not-a-migration.sql');
    expect(
      out,
      `only files under ${MIGRATION_SQL_DIR}/ are scanned by the lint, so a .sql ` +
        'elsewhere cannot violate the invariant',
    ).not.toContain(FC_TASK);
  });

  it('does NOT attach for a parked .DRAFT OUTSIDE the scanned migrations directory', () => {
    const out = dryTasks('apps/operator/docs/examples/999-not-a-migration.sql.DRAFT');
    expect(out).not.toContain(FC_TASK);
  });

  it('keeps the guard script defined, so the attachment cannot silently no-op', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(
      pkg.scripts?.[FC_SCRIPT],
      `${HOST_WORKSPACE} must define "${FC_SCRIPT}". The router only builds a task when ` +
        'the script exists on the HOST workspace — defining it only in the ROOT ' +
        'package.json is not enough, and that exact mistake made this guard attach ' +
        'nothing while every probe still looked healthy.',
    ).toBeTruthy();
    expect(pkg.scripts?.[FC_SCRIPT]).toContain('check-migration-forward-compat.mjs');
  });
});

/**
 * EI-20820551755839769 — migration edits must run the LIVE-SCHEMA half of the
 * prose-vector width contract. The detector already enumerates every vector column in
 * harness_shared and rejects an unaccounted surface; this block proves the affected-test
 * router actually places that detector where a new column enters the schema.
 */
describe('affected-tests: prose-vector live-schema guard (EI-20820551755839769)', () => {
  const SCRIPT = 'test:integration:prose-vector-dims';
  const TASK = `${HOST_WORKSPACE} :: ${SCRIPT}`;
  const MIGRATION_PATH = `${MIGRATION_SQL_DIR}/999-add-vector-surface.sql`;

  it('attaches the focused live-schema guard for a migration SQL change', () => {
    const out = dryTasks(MIGRATION_PATH);
    expect(
      out,
      'a migration can add an unenumerated or stale-width vector column while every unit ' +
        'test stays green; the focused integration contract must inspect the migrated catalog',
    ).toContain(TASK);
  });

  it('STILL attaches when operator-core unit tests are selected', () => {
    const out = dryTasks(MIGRATION_PATH);
    expect(out, 'the host workspace should be independently affected by this path').toContain(
      `${HOST_WORKSPACE} :: test`,
    );
    expect(
      out,
      'operator-core test excludes *.integration.test.ts, so its unit suite cannot replace ' +
        'the focused live-schema task',
    ).toContain(TASK);
  });

  it('does NOT attach for a migration-looking SQL file outside the migration directory', () => {
    expect(dryTasks('apps/operator/docs/examples/999-add-vector-surface.sql')).not.toContain(TASK);
  });

  it('keeps the focused script declared with the integration config and exact contract file', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const command = pkg.scripts?.[SCRIPT];
    expect(command, `missing ${HOST_WORKSPACE} script ${SCRIPT}`).toBeTruthy();
    expect(command).toContain('vitest.integration.config.ts');
    expect(command).toContain('lib/search/prose-vector-dims.integration.test.ts');
  });
});

/**
 * WI-10003236 — applyMigrationsForTest catches a stale fixture list only when the
 * real-Postgres fixture runs. The ordinary operator-core task excludes integration
 * tests, so route these fixtures from migration changes and the inputs that can detach
 * their guard.
 */
describe('affected-tests: work-item migration fixture guard (WI-10003236)', () => {
  const SCRIPT = 'test:integration:work-items-migration-fixtures';
  const TASK = `${HOST_WORKSPACE} :: ${SCRIPT}`;
  const MIGRATION_PATH = `${MIGRATION_SQL_DIR}/999-work-items-fixture-probe.sql`;
  const TRIGGER_PATHS = [
    MIGRATION_PATH,
    'libs/papercusp',
    'packages/operator-core/lib/work-items-closed-ts.integration.test.ts',
    'packages/operator-core/lib/work-items-terminal-attribution-preserve.integration.test.ts',
    'packages/operator-core/test/_pg-helpers.ts',
    'packages/operator-core/test/_work-items-schema.ts',
    'packages/operator-core/vitest.integration.config.ts',
    'packages/operator-core/package.json',
    'scripts/affected-tests.mjs',
  ];

  it.each(TRIGGER_PATHS)('attaches the fixture integration task for a contract input: %s', (changedPath) => {
    expect(
      dryTasks(changedPath),
      `${changedPath} can stale or detach the work-item migration fixtures; the focused real-Postgres task must run`,
    ).toContain(TASK);
  });

  it('does NOT attach for an unrelated operator-core source file', () => {
    expect(dryTasks('packages/operator-core/lib/rubrics.ts')).not.toContain(TASK);
  });

  it('keeps the focused script scoped to both fixture tests and the integration config', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const command = pkg.scripts?.[SCRIPT];
    expect(command, `missing ${HOST_WORKSPACE} script ${SCRIPT}`).toBeTruthy();
    expect(command).toContain('PAPERCUSP_TEST_RUN_HARNESS=papercusp');
    expect(command).toContain('vitest.integration.config.ts');
    expect(command).toContain('lib/work-items-closed-ts.integration.test.ts');
    expect(command).toContain('lib/work-items-terminal-attribution-preserve.integration.test.ts');
    expect(command).not.toContain('--passWithNoTests');
  });
});

/**
 * WI-10004160 — the federated-column drift guard went unrun for a month (2026-08-29 →
 * 2026-09-30) because it is an integration test and nothing in the local gate selected it;
 * 16 columns on 4 federated tables landed neither carried nor declared machine-local. Both
 * sides of its contract (a migration adds the column; the mapper/projections carry it) must
 * place the focused guard.
 */
describe('affected-tests: federated-column drift guard (WI-10004160)', () => {
  const SCRIPT = 'test:integration:federated-column-completeness';
  const TASK = `${HOST_WORKSPACE} :: ${SCRIPT}`;

  it('attaches for a migration SQL change (the side that adds a column)', () => {
    expect(dryTasks(`${MIGRATION_SQL_DIR}/999-add-federated-column.sql`)).toContain(TASK);
  });

  it('attaches for the federation value mapper and a projection (the side that carries it)', () => {
    expect(dryTasks('packages/operator-core/lib/sync/hyperbee/feature-issue-op-keys.ts')).toContain(TASK);
    expect(dryTasks('packages/operator-core/lib/sync/hyperbee/projections/harness-plans.ts')).toContain(TASK);
  });

  it('does NOT attach for an unrelated operator-core source file', () => {
    expect(dryTasks('packages/operator-core/lib/rubrics.ts')).not.toContain(TASK);
  });

  it('keeps the focused script declared with the integration config and exact contract file', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const command = pkg.scripts?.[SCRIPT];
    expect(command, `missing ${HOST_WORKSPACE} script ${SCRIPT}`).toBeTruthy();
    expect(command).toContain('vitest.integration.config.ts');
    expect(command).toContain('lib/sync/hyperbee/__tests__/federated-column-completeness.integration.test.ts');
  });
});

/**
 * WI-2141163 — the real-Postgres resource-governor queue recurrence suite must be
 * selected by the local affected-tests path. The ordinary operator-core task is
 * unit-layer and excludes `*.integration.test.ts`; the broad integration flag is
 * opt-in and has no local green-checkpoint caller. This focused route is the
 * recurrence guard, and its config assertions keep the later agent-mcp cleanup
 * from moving the only recurring integration file back to zero coverage.
 */
describe('affected-tests: resource-governor queue integration guard (WI-2141163)', () => {
  const SCRIPT = 'test:integration:resource-governor-queue';
  const TASK = `${HOST_WORKSPACE} :: ${SCRIPT}`;
  const QUEUE_TEST_PATH = 'packages/operator-core/lib/resource-governor/queue.integration.test.ts';
  const QUEUE_SOURCE_PATH = 'packages/operator-core/lib/resource-governor/queue.ts';
  const ADMISSION_SOURCE_PATH = 'packages/operator-core/lib/resource-governor/admission.ts';
  const MIGRATION_PATH = `${MIGRATION_SQL_DIR}/986-resource-governor-work-item-queue-identity.sql`;
  const UNRELATED_RESOURCE_PATH = 'packages/operator-core/lib/resource-governor/controller.ts';

  it.each([QUEUE_TEST_PATH, QUEUE_SOURCE_PATH, ADMISSION_SOURCE_PATH, MIGRATION_PATH, 'libs/papercusp'])(
    'attaches the focused queue integration task for a contract input: %s',
    (changedPath) => {
      const out = dryTasks(changedPath);
      expect(out, 'the operator-core unit task should still be selected for the changed contract input').toContain(
        `${HOST_WORKSPACE} :: test`,
      );
      expect(
        out,
        `${changedPath} can change durable queue behavior or its schema; the focused real-Postgres ` +
          'recurrence suite must run without requiring the broad --integration sweep',
      ).toContain(TASK);
    },
  );

  it('does NOT attach for an unrelated resource-governor source file', () => {
    expect(
      dryTasks(UNRELATED_RESOURCE_PATH),
      'the focused queue venue must not become an all-resource-governor integration tax',
    ).not.toContain(TASK);
  });

  it('keeps the focused script declared with the integration config and exact queue test', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const command = pkg.scripts?.[SCRIPT];
    expect(command, `missing ${HOST_WORKSPACE} script ${SCRIPT}`).toBeTruthy();
    expect(command).toContain('vitest.integration.config.ts');
    expect(command).toContain('lib/resource-governor/queue.integration.test.ts');
    expect(command).not.toContain('--passWithNoTests');
  });

  it('keeps agent-mcp unit and integration configs disjoint after the caller is wired', () => {
    const unitConfig = readFileSync(resolve(REPO_ROOT, 'packages/agent-mcp/vitest.config.ts'), 'utf8');
    const integrationConfig = readFileSync(resolve(REPO_ROOT, 'packages/agent-mcp/vitest.integration.config.ts'), 'utf8');
    expect(unitConfig).toContain("include: ['src/**/*.test.ts']");
    expect(unitConfig).toContain("exclude: ['src/**/*.integration.test.ts']");
    expect(integrationConfig).toContain("layer: 'integration'");
    expect(integrationConfig).toContain("include: ['src/**/*.integration.test.ts']");
  });
});

/**
 * EI-23210600888560844 — the private-Postgres sessions:read regression suite must
 * be selected by the ordinary affected-tests path. The operator-core unit task
 * excludes `*.integration.test.ts`, and the broad integration task is opt-in, so
 * this focused route is the only local promotion signal for the real SQL contract.
 */
describe('affected-tests: sessions/read private-PG integration guard (EI-23210600888560844)', () => {
  const SCRIPT = 'test:integration:sessions-read';
  const TASK = `${HOST_WORKSPACE} :: ${SCRIPT}`;
  const TRIGGER_PATHS = [
    'package.json',
    'packages/operator-core/package.json',
    'packages/operator-core/vitest.integration.config.ts',
    'scripts/affected-tests.mjs',
    'packages/operator-core/lib/agent-tools/sessions/read.ts',
    'packages/operator-core/lib/agent-tools/sessions/read.integration.test.ts',
    'packages/operator-core/lib/agent-tools/sessions/_shared.ts',
    'packages/operator-core/lib/agent-tools/sessions/search.ts',
    'packages/operator-core/lib/agent-tools/search/filters.ts',
    'packages/operator-core/test/_pg-helpers.ts',
  ];
  const UNRELATED_SESSION_TOOL_PATH = 'packages/operator-core/lib/agent-tools/sessions/list.ts';

  it.each(TRIGGER_PATHS)('attaches the focused sessions/read task for a contract input: %s', (changedPath) => {
    const out = dryTasks(changedPath);
    expect(out, 'the operator-core unit task should still be selected for the changed contract input').toContain(
      `${HOST_WORKSPACE} :: test`,
    );
    expect(
      out,
      `${changedPath} can change the sessions:read SQL contract or its private-PG test venue; ` +
        'the focused integration task must run without requiring the broad --integration sweep',
    ).toContain(TASK);
  });

  it('does NOT attach for an unrelated sessions tool', () => {
    expect(
      dryTasks(UNRELATED_SESSION_TOOL_PATH),
      'the focused sessions/read venue must not become an all-sessions private-Postgres tax',
    ).not.toContain(TASK);
  });

  it('keeps the focused script declared with the integration config and exact reader test', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const command = pkg.scripts?.[SCRIPT];
    expect(command, `missing ${HOST_WORKSPACE} script ${SCRIPT}`).toBeTruthy();
    expect(command).toContain('vitest.integration.config.ts');
    expect(command).toContain('lib/agent-tools/sessions/read.integration.test.ts');
    expect(command).not.toContain('--passWithNoTests');
  });
});

/**
 * WI-38351 — the SAME class as the forward-compat guard above, on the SAME corpus, found
 * the same way: `lint:migrations` was a gate-only lint, so the author of a bad migration
 * saw a green `npm run test:affected` and the fleet learned about it hours later as a red
 * green-checkpoint that blocked every agent's deploy.
 *
 * It had already happened three times when this was wired (WI-38348 / migration 815,
 * EI-20224121418388370, EI-10999 — each an NNN-*.sql committed with no reservation row),
 * and the last occurrence was expensive out of proportion to the defect: the 1.1s detector
 * existed the whole time, four different agents raced to write the same one-line backfill,
 * and three of those raced files landed. Nothing about that cost was caused by the missing
 * row; all of it was caused by finding out late.
 *
 * The two directions are tested because a registration that attaches to EVERYTHING is as
 * wrong as one that attaches to nothing — it just fails by spending every agent's edit
 * budget instead of by staying silent.
 */
describe('affected-tests: migration lint guard (WI-38351)', () => {
  const LM_SCRIPT = 'lint:migrations';
  const LM_TASK = `${HOST_WORKSPACE} :: ${LM_SCRIPT}`;
  const MIGRATION_PATH = `${MIGRATION_SQL_DIR}/750-drop-dead-hfc-partial-indexes.sql`;

  it('attaches for a migration .sql change — the moment the number is still cheap to fix', () => {
    const out = dryTasks(MIGRATION_PATH);
    expect(
      out,
      `a migration at ${MIGRATION_PATH} must run lint:migrations locally. Before this ` +
        'wiring it ran ONLY inside green-checkpoint, so an unreserved NNN (or a raw ' +
        'BEGIN/COMMIT, or a duplicate number) got zero local signal and red-pinned the ' +
        'shared gate for the whole fleet hours later.',
    ).toContain(LM_TASK);
  });

  it('attaches for the bare libs/papercusp gitlink path used for nested edits', () => {
    const submodule = someSubmodulePath();
    expect(submodule).toBe('libs/papercusp');
    expect(
      dryTasks(submodule),
      'a nested migration edit is reported as the bare submodule gitlink; omitting this ' +
        'root trigger lets the migration lint skip the exact change that introduced it',
    ).toContain(LM_TASK);
  });

  it('attaches when the LINTER itself changes, which can invalidate the whole corpus at once', () => {
    expect(dryTasks('scripts/lint-migrations.mjs')).toContain(LM_TASK);
  });

  it('attaches when the ALLOCATOR changes, since it hands out the numbers this lint checks', () => {
    expect(dryTasks('scripts/next-migration.mjs')).toContain(LM_TASK);
  });

  it('STILL attaches when the host workspace is affected, because nothing in that suite re-runs it', () => {
    // The same skip-branch trap the forward-compat sibling documents above, and the reason
    // this guard deliberately declares NO hostSuiteRatchet: libs/papercusp/** reaches
    // operator-core through the dependency graph, so a migration .sql pulls the host
    // workspace into the affected set. Declaring a ratchet would therefore disable the
    // guard on exactly the changesets it exists for. operator-core's suite does contain
    // lint-migrations.test.ts, but that exercises the helpers against fixtures and never
    // scans the real SQL directory or reads the reservations table — so deferring to it
    // would run nothing at all while looking, from every output, like success.
    const out = dryTasks(MIGRATION_PATH);
    expect(out, 'the host workspace should run its own suite here').toContain(`${HOST_WORKSPACE} :: test`);
    expect(
      out,
      'lint:migrations declares no hostSuiteRatchet, so the host suite running is NOT a ' +
        `substitute for it. Task list was:\n${out}`,
    ).toContain(LM_TASK);
  });

  it('does NOT attach for a migration-looking .sql OUTSIDE the scanned migrations directory', () => {
    expect(
      dryTasks('apps/operator/docs/examples/999-not-a-migration.sql'),
      'only files under the scanned migrations dir can violate the invariant',
    ).not.toContain(LM_TASK);
  });

  it('does NOT attach for an unrelated source change', () => {
    expect(
      dryTasks('packages/operator-core/lib/agent-tools/index.ts'),
      'a TS edit cannot change a migration number, so paying the scan here is pure waste',
    ).not.toContain(LM_TASK);
  });

  it('keeps the guard script defined ON THE HOST WORKSPACE, so the attachment cannot silently no-op', () => {
    // Step two of the two-step registration. The router `continue`s when the host
    // workspace does not define the script, and `lint:migrations` lived ONLY in the root
    // package.json — so the registry entry alone would have attached nothing and looked
    // exactly like success from every probe.
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(
      pkg.scripts?.[LM_SCRIPT],
      `${HOST_WORKSPACE} must define "${LM_SCRIPT}" — defining it only in the ROOT ` + 'package.json is not enough.',
    ).toBeTruthy();
    expect(pkg.scripts?.[LM_SCRIPT]).toContain('lint-migrations.mjs');
  });
});
