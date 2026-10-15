/**
 * identity-keyed-classification-gate.test.ts — falsifiability + calibration for
 * the pre-promotion gate that closes EI-20012634773877104's atomicity window.
 *
 * WHAT IS BEING GUARDED
 * ---------------------
 * `scripts/check-identity-keyed-classification.mjs` is called by
 * pull-schema.mjs immediately BEFORE it promotes a candidate schema into
 * `libs/papercusp/libs/db/src/schema/generated.ts`. If the candidate would
 * introduce an identity-keyed column with no ALLOWLIST classification, the
 * promotion is refused — so the inconsistent tree state never reaches disk,
 * git-sync can never sweep it into a commit, and the fleet-wide gate can never
 * cut a candidate on it.
 *
 * A guard that has never failed is a guard nobody has tested, and the failure
 * mode that matters here is the SILENT one: a guard that always passes would
 * look exactly like a guard that is working, right up until the next migration
 * reds main for everyone. So this file proves the gate fires in the positive
 * direction AND that it stays quiet on the real, fully-classified schema.
 *
 * WHY NO IN-TREE MUTATION
 * -----------------------
 * The obvious way to prove a schema guard fires — edit generated.ts, run,
 * restore — is unsafe in this repo: git-sync sweeps the whole working tree on
 * a schedule and would happily commit the mutant while the probe is still
 * running (a trap CLAUDE.md documents, and one no `trap` handler can close).
 * The census test's `IDENTITY_KEYED_SCHEMA_PATH` override exists precisely so
 * the subject can be a COPY outside the tree. Every case below writes its
 * fixture to `os.tmpdir()`; the shared checkout is never touched.
 */
import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// @ts-expect-error — plain-JS repo guard, intentionally not typed
import { checkIdentityKeyedClassification, buildCensusChildEnv, CENSUS_TEST_REL, OPERATOR_CORE_REL, TEST_REUSE_SKIP_LIST_ENV, TEST_LANE_ENV, TEST_FILTER_LIST_ENV, TEST_SELECTION_ENVS } from '../../../../../scripts/check-identity-keyed-classification.mjs';
import { resolveTestRunSource } from '../../testing-run-source';
import {
  PC_TEST_REUSE_SKIP_LIST_ENV,
  REUSE_SKIP_LIST_SCHEMA,
  executedSourceRunContext,
  executedSourceRunnerIdentity,
} from '@papercusp/test-config/test-pass-reuse-skip';

const REAL_SCHEMA = resolve(
  __dirname,
  '../../../../../libs/papercusp/libs/db/src/schema/generated.ts',
);

const TEST_CONFIG_SRC = resolve(__dirname, '../../../../../libs/test-config/src');

/**
 * Every `export const PC_TEST_*_ENV = '<name>'` in libs/test-config/src, read from
 * source so a channel added in any module there is seen without being imported.
 */
function testConfigSelectionEnvs(): Map<string, string> {
  const found = new Map<string, string>();
  const files = readdirSync(TEST_CONFIG_SRC, { recursive: true }) as string[];
  for (const rel of files) {
    if (!rel.endsWith('.ts') || /\.test\.ts$/.test(rel) || rel.includes('__fixtures__')) continue;
    const text = readFileSync(join(TEST_CONFIG_SRC, rel), 'utf8');
    for (const m of text.matchAll(/export const (PC_TEST_[A-Z0-9_]+_ENV)\s*=\s*['"]([^'"]+)['"]/g)) {
      found.set(m[1], m[2]);
    }
  }
  return found;
}

/** Spawning vitest per case costs ~8s; well past the 5s default. */
const SPAWN_TIMEOUT_MS = 180_000;

describe('identity-keyed classification pre-promotion gate (EI-20012634773877104)', () => {
  it(
    'CALIBRATION: passes on the real, fully-classified schema',
    async () => {
      // If this ever fails, the cases below prove nothing — a guard that
      // rejects everything "catches" every mutant for free.
      const verdict = checkIdentityKeyedClassification({});
      expect(verdict.code, verdict.output?.slice(-1500)).toBe('classified');
      expect(verdict.ok).toBe(true);
    },
    SPAWN_TIMEOUT_MS,
  );

  // WI-10002179. The nested `vitest run` this guard spawns inherits the fleet
  // gate's own test_runs stamps through `{ ...process.env }`, and the reporter
  // that writes harness_shared.test_runs is auto-wired into every workspace. So
  // the FIRES case below — which fails BY DESIGN — used to record a row that no
  // gate read could tell apart from a genuine failure of the tracked census
  // file: source='ci', worktree_dirty=false, commit_sha=<the frozen candidate>.
  // Measured 2026-09-21 at candidates 6e6405037324 and 80959359392e, each sitting
  // beside PASSING rows for the same file at the same sha in the same minute.
  //
  // Asserted through resolveTestRunSource rather than against the literal env
  // name on purpose: the property that matters is "this row is not a ci verdict",
  // and pinning the predicate keeps this guard honest if the knob is ever renamed.
  it('does NOT record an override run as a ci verdict on the tracked census file', () => {
    const gateEnv = {
      PAPERCUSP_TEST_RUN_SOURCE: 'ci',
      PAPERCUSP_TEST_RUN_GROUP: 'run-abc',
      CI: '1',
    };

    const override = buildCensusChildEnv(gateEnv, '/tmp/candidate-generated.ts');
    expect(override.IDENTITY_KEYED_SCHEMA_PATH).toBe('/tmp/candidate-generated.ts');
    expect(resolveTestRunSource(override)).not.toBe('ci');
    expect(resolveTestRunSource(override)).toBe('mutation-probe');

    // The dual, and the reason this is scoped to the override branch: a run
    // against the TRACKED mirror is a real verdict on a real file and must keep
    // recording as one, or the fix would blind the gate instead of de-noising it.
    const tracked = buildCensusChildEnv(gateEnv, null);
    expect(tracked.IDENTITY_KEYED_SCHEMA_PATH).toBeUndefined();
    expect(resolveTestRunSource(tracked)).toBe('ci');
  });

  // WI-10004340 (verify 1b0ba635, repairHead 405e4000): the gate arms
  // PC_TEST_REUSE_SKIP_LIST for its own vitest run, and the census file is ON that
  // list whenever it holds a pass proof. Inherited by the nested run, it excluded
  // the only target ("No test files found") and both spawning cases reported a
  // false verdict. The channel name is pinned to the reader's own constant so a
  // rename cannot silently re-open the leak.
  it('never hands the gate reuse skip list to the nested census run', () => {
    expect(TEST_REUSE_SKIP_LIST_ENV).toBe(PC_TEST_REUSE_SKIP_LIST_ENV);
    // Verify 05c11967 (repairHead 636fbe98): the lane selector leaks the same way. The
    // gate's lane-stateful leg exports PC_TEST_LANE=stateful, whose lane split excludes the
    // census file, so the nested run reported `unclassified` on the real schema.
    expect(TEST_LANE_ENV).toBe('PC_TEST_LANE');
    // Verify 4988081a (repairHead d740fc38): and through the related-files filter list,
    // whose 2,853 listed files did not include the census file.
    expect(TEST_FILTER_LIST_ENV).toBe('PC_TEST_FILTER_LIST');
    const gateEnv: Record<string, string> = {
      [PC_TEST_REUSE_SKIP_LIST_ENV]: '/tmp/pcv/reuse-skip-x.json',
      [TEST_LANE_ENV]: 'stateful',
      [TEST_FILTER_LIST_ENV]: '/tmp/pcv/related-filter-x.json',
      KEEP: 'y',
    };
    for (const schemaAbs of [null, '/tmp/candidate-generated.ts']) {
      const child = buildCensusChildEnv(gateEnv, schemaAbs);
      for (const name of TEST_SELECTION_ENVS) expect(child[name], name).toBeUndefined();
      expect(child.KEEP).toBe('y');
    }
    // The caller's env is copied, never mutated.
    expect(gateEnv[PC_TEST_REUSE_SKIP_LIST_ENV]).toBe('/tmp/pcv/reuse-skip-x.json');
  });

  // The leak above arrived one channel per gate red, three times. This pins the scrub
  // set to the channels libs/test-config actually defines, so the fourth channel fails
  // here, on the edit that adds it, instead of as an intermittent gate red.
  it('scrubs exactly the selection channels libs/test-config defines', () => {
    const defined = testConfigSelectionEnvs();
    // Positive control: the source scan must see a channel this file also imports,
    // or an empty scan would make the comparison below meaningless.
    expect(defined.get('PC_TEST_REUSE_SKIP_LIST_ENV')).toBe(PC_TEST_REUSE_SKIP_LIST_ENV);
    expect([...TEST_SELECTION_ENVS].sort()).toEqual([...new Set(defined.values())].sort());
  });

  it(
    'CALIBRATION under the gate reuse env: still runs the census file when it is on the skip list',
    async () => {
      // End-to-end falsifier: a real, APPLICABLE skip list naming the census file,
      // exported the way the gate exports it. Before the fix the nested vitest
      // excluded its only target and this returned a non-classified verdict.
      const dir = mkdtempSync(join(tmpdir(), 'identity-keyed-reuse-'));
      const listPath = join(dir, 'reuse-skip-test.json');
      writeFileSync(
        listPath,
        JSON.stringify({
          schema: REUSE_SKIP_LIST_SCHEMA,
          files: [CENSUS_TEST_REL],
          runContext: executedSourceRunContext(process.env),
          runnerIdentity: executedSourceRunnerIdentity(),
          judgedSha: '0'.repeat(40),
        }),
      );
      // A related-files list that does not name the census file, as in verify 4988081a.
      const filterPath = join(dir, 'related-filter-test.json');
      writeFileSync(filterPath, JSON.stringify(['lib/agent-tools/coordination/not-the-census.test.ts']));
      const gateEnv: Record<string, string> = {
        [PC_TEST_REUSE_SKIP_LIST_ENV]: listPath,
        // The gate's lane-stateful leg exports this too; its lane split excludes the census file.
        [TEST_LANE_ENV]: 'stateful',
        [TEST_FILTER_LIST_ENV]: filterPath,
      };
      const prior = Object.fromEntries(Object.keys(gateEnv).map((k) => [k, process.env[k]]));
      Object.assign(process.env, gateEnv);
      try {
        const verdict = checkIdentityKeyedClassification({});
        expect(verdict.code, verdict.output?.slice(-1500)).toBe('classified');
        expect(verdict.ok).toBe(true);
      } finally {
        for (const [k, v] of Object.entries(prior)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'FIRES: refuses a candidate schema carrying an unclassified identity-keyed column',
    async () => {
      // Surgical mutant: the REAL schema plus ONE fabricated identity-keyed
      // column. Every pre-existing column still classifies and every ALLOWLIST
      // entry still matches, so the canary and allowlist-rot assertions stay
      // green and the ONLY thing that can fail is the new column. That is what
      // makes a caught mutant attributable to the property under test rather
      // than to a broken fixture.
      const dir = mkdtempSync(join(tmpdir(), 'identity-keyed-gate-'));
      const candidate = join(dir, 'generated.ts');
      try {
        const real = readFileSync(REAL_SCHEMA, 'utf8');
        // Not `_`-prefixed (stripped upstream) and not `bak_` (frozen-snapshot
        // skip), so it genuinely reaches the classification assertion.
        const mutant = `${real}
export const ei20012634773877104ProbeInHarnessShared = harnessShared.table("ei20012634773877104_probe", {
\townerId: text("owner_id").notNull(),
});
`;
        writeFileSync(candidate, mutant);

        const verdict = checkIdentityKeyedClassification({ schemaPath: candidate });

        expect(verdict.ok).toBe(false);
        expect(verdict.code).toBe('unclassified');
        // Pin the REASON, not just the exit status: the guard derives
        // 'unclassified' from any non-zero exit, so asserting only on the code
        // would also accept a fixture that failed for an unrelated reason
        // (a broken canary, an ENOENT) and quietly stop testing this property.
        expect(verdict.output).toContain('no classification');
        expect(verdict.output).toContain('ei20012634773877104_probe.owner_id');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  it('distinguishes "could not run" from "unclassified"', () => {
    // pull-schema.mjs hard-BLOCKS promotion on 'unclassified' but only warns on
    // 'check-unavailable', because an instrument that did not run has told us
    // nothing and must not wedge the fleet's migration flow. Collapsing the two
    // would either block every agent on a missing file or silently swallow a
    // real unclassified column, so the distinction is load-bearing.
    const verdict = checkIdentityKeyedClassification({
      schemaPath: join(tmpdir(), 'definitely-does-not-exist-ei20012634773877104.ts'),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('check-unavailable');
  });

  it(
    'reports a run that selected no test file as check-unavailable, not unclassified',
    () => {
      // The three gate reds above all surfaced as `unclassified` on a fully classified
      // schema, because vitest exits 1 when selection leaves it nothing to run. A fake
      // checkout whose `vitest` prints exactly what the gate's nested run printed keeps
      // this deterministic and independent of whichever channel leaks next.
      const root = mkdtempSync(join(tmpdir(), 'identity-keyed-noselect-'));
      try {
        const pkg = join(root, OPERATOR_CORE_REL);
        mkdirSync(dirname(join(pkg, CENSUS_TEST_REL)), { recursive: true });
        writeFileSync(join(pkg, CENSUS_TEST_REL), '');
        writeFileSync(join(pkg, 'package.json'), '{"name":"noselect-fixture","private":true}');
        const bin = join(pkg, 'node_modules', '.bin', 'vitest');
        mkdirSync(dirname(bin), { recursive: true });
        writeFileSync(bin, '#!/bin/sh\necho "No test files found, exiting with code 1"\nexit 1\n');
        chmodSync(bin, 0o755);

        const verdict = checkIdentityKeyedClassification({ repoRoot: root });
        expect(verdict.output).toContain('No test files found');
        expect(verdict.ok).toBe(false);
        expect(verdict.code).toBe('check-unavailable');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});
