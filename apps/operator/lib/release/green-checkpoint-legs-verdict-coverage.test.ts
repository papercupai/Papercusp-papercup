/**
 * green-checkpoint: EVERY post-suite leg that can FAIL must red the verdict.
 *
 * `runGreen` computes `green = r.code === 0 && legs.ok` (green-checkpoint.ts), so
 * `legs.ok` IS the gate verdict for everything the suite itself does not cover.
 * `legs.ok` was a HAND-MAINTAINED list of leg fields — and a leg added to
 * `PostSuiteLegs` + `legsNotRun` + its own exec block, but forgotten in that list,
 * is silently excluded from the verdict.
 *
 * Measured 2026-08-09 (P-026): `lintMockCastEscape` was exactly that. It ran at
 * green-checkpoint.ts:5111, set `status:'failed'` and `haltedBy` on a red — which
 * SKIPS every later leg (`lintPlane`, `build`) — while being absent from the
 * `legs.ok` aggregation. Net effect of a `lint:mock-cast-escape` red: the plane
 * lints and the SPA build never ran, and the gate reported GREEN anyway. A false
 * green that also silently drops two real legs is the most expensive shape this
 * file has (cf. the WI-6053 incident in runPostSuiteLegs' own doc comment, where
 * five legs defaulted to `true` and an untypechecked candidate reached `main`).
 *
 * ANCHORED TO THE PROPERTY, NOT TO A NAME LIST. This test does not enumerate legs
 * by hand — a hardcoded list would need the same maintenance the bug came from,
 * and would go stale in the identical way. Instead it DISCOVERS the legs by
 * running the real `runPostSuiteLegs` against the real root package.json with a
 * stubbed exec, recording every `npm run <script>` it invokes, then re-runs once
 * per script failing exactly that one and asserts the invariant:
 *
 *     any leg with status 'failed'  ⇒  legs.ok === false
 *
 * A new leg is therefore covered the moment it is wired, with no edit here.
 */
import { describe, it, expect } from 'vitest';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { pathToFileURL } from 'node:url';
import { createFrozenCandidateRepairQueue, markFrozenRepairAdmitted } from '@papercusp/operator-core/lib/release/frozen-candidate-repair-queue';
import { withMeasuredLegSubjects, withRepairManifest } from '@papercusp/operator-core/lib/release/repair-manifest';
import { readGateCandidateFailures } from '@papercusp/operator-core/lib/gate-candidate-failures';
import {
  runPostSuiteLegs,
  isRerunnableGateEntry,
  checkNpmScript,
  OPERATOR_CORE_TSCONFIG_RELPATH,
  type CheckpointExec,
} from './green-checkpoint';

/** Repo root: apps/operator/lib/release/ -> ../../../.. */
const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

const ok = { code: 0, stdout: '', stderr: '' };

/** The npm script name of an `npm run <script>` / `npm --workspace X run <script>` argv. */
function npmScriptOf(cmd: string, args: string[]): string | null {
  if (cmd !== 'npm') return null;
  const i = args.indexOf('run');
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

/**
 * Run the real leg chain with a stub exec. `failScript` (when given) is the ONE npm
 * script that exits non-zero; everything else — including the non-npm `git grep`
 * conflict-marker probe — succeeds.
 */
async function runLegs(failScript: string | null) {
  const invokedScripts: string[] = [];
  const exec: CheckpointExec = async (cmd, args) => {
    const script = npmScriptOf(cmd, args);
    if (script) invokedScripts.push(script);
    // `git grep` for conflict markers: exit 1 == "clean" (no match), which is what we want.
    if (cmd === 'git') return { code: 1, stdout: '', stderr: '' };
    if (script && script === failScript) {
      return { code: 1, stdout: `stub: ${script} failed`, stderr: '' };
    }
    return ok;
  };
  // `exec` is stubbed, so the env is never used to spawn anything — pass the real one
  // rather than a cast so the call keeps the production signature exactly.
  const legs = await runPostSuiteLegs(ROOT, process.env, exec, '@papercusp/operator-vite');
  return { legs, invokedScripts };
}

/** Every leg field on the result that carries a `status` (i.e. is a LegOutcome). */
function legEntries(legs: Awaited<ReturnType<typeof runLegs>>['legs']) {
  return Object.entries(legs).filter(
    (e): e is [string, { status: string; skipReason?: string }] =>
      typeof e[1] === 'object' && e[1] !== null && 'status' in (e[1] as object),
  );
}

describe('green-checkpoint post-suite legs — verdict coverage', () => {
  it('freezes the same complete post-suite population before passing or failed outcomes', async () => {
    const { postSuiteContinuationPopulation } = await import('./green-checkpoint');
    const population = postSuiteContinuationPopulation();
    const pass = await runLegs(null);
    const fail = await runLegs('lint:mock-cast-escape');
    expect(population.coverage).toBe('complete');
    expect(population.units.map(unit => unit.id)).toEqual(pass.legs.records.map(leg => `post:${leg.id}`));
    expect(population.units.map(unit => unit.id)).toEqual(fail.legs.records.map(leg => `post:${leg.id}`));
    expect(population.units.length).toBeGreaterThan(5);
    population.units.pop();
    expect(postSuiteContinuationPopulation().units).toHaveLength(pass.legs.records.length);
    expect(fail.legs.ok).toBe(false);
  });
  it('P036: a seeded real lint violation survives output truncation into manifest, admission and named per-leg evidence', async () => {
    const file = 'packages/operator-core/lib/seeded-violation.test.ts';
    const { findMockCastEscapesInText } = await import(pathToFileURL(join(ROOT, 'scripts/check-mock-cast-escape.mjs')).href);
    const findings = findMockCastEscapesInText('vi.mocked(fn).mockResolvedValue({} as never);', file);
    expect(findings).toHaveLength(1);
    const id = 'lint:mock-cast-escape';
    const exec: CheckpointExec = async (cmd, args) => {
      if (cmd === 'git') return { code: 1, stdout: '', stderr: '' };
      return npmScriptOf(cmd, args) === id
        ? { code: 1, stdout: `${file}:1: mock cast escape\n${'generic trailer\n'.repeat(600)}`, stderr: '' }
        : ok;
    };
    const legs = await runPostSuiteLegs(ROOT, process.env, exec, '@papercusp/operator-vite', {
      identity: { candidate: 'a'.repeat(40), headAtStart: 'a'.repeat(40), runId: 'seeded-lint' },
    });
    const leg = legs.records.find((record) => record.id === id)!;
    expect(leg.status).toBe('failed');
    expect(leg.executionIdentity?.result.output).not.toContain(file);
    expect(leg.subjectPaths).toEqual([file]);
    const head = 'a'.repeat(40);
    const queue = createFrozenCandidateRepairQueue({ candidate: head, base: null, nowMs: 1,
      failingTests: [id], signature: [{ id, kind: 'lint-leg', recipe: `npm run ${id}` }],
    });
    const measured = withMeasuredLegSubjects(queue, head, legs.records, 2);
    const persisted = withRepairManifest(measured, 3).queue;
    expect(persisted.manifest.rows.find((row) => row.legId === id)).toMatchObject({ subjectPaths: [file], admitCommand: expect.stringContaining(file) });
    const reading = await readGateCandidateFailures({ candidateSha: null, repairHeadSha: head, root: ROOT, queueLegs: persisted.legs });
    expect(reading.nonTestLegs.perLeg.map((row) => row.id)).toContain(id);
    const admitted = markFrozenRepairAdmitted(persisted, { atMs: 4, actor: 'test-fixer', source: { ref: 'staging', sha: 'b'.repeat(40) },
      fromRepairHead: head, toRepairHead: 'c'.repeat(40), paths: [file], unchanged: [], blobs: { [file]: 'd'.repeat(40) },
    });
    expect(withRepairManifest(admitted, 5).manifest.rows.find((row) => row.legId === id)?.status.kind).toBe('admitted');
  });
  it('P-017 (R-14): a failed leg keys every error from its FULL output, not the stored tail', async () => {
    const id = 'lint:mock-cast-escape';
    const exec: CheckpointExec = async (cmd, args) => {
      if (cmd === 'git') return { code: 1, stdout: '', stderr: '' };
      return npmScriptOf(cmd, args) === id
        ? {
            code: 1,
            stdout:
              'lib/a.ts(3,5): error TS2322: Type mismatch.\n' +
              'lib/a.ts(9,1): error TS2322: Type mismatch.\n' +
              'lib/b.ts:4:2 - error TS2345: Bad argument.\n' +
              'generic trailer\n'.repeat(600),
            stderr: '',
          }
        : ok;
    };
    const legs = await runPostSuiteLegs(ROOT, process.env, exec, '@papercusp/operator-vite', {
      identity: { candidate: 'a'.repeat(40), headAtStart: 'a'.repeat(40), runId: 'p017-error-keys' },
    });
    const leg = legs.records.find((record) => record.id === id)!;
    expect(leg.status).toBe('failed');
    // The errors are gone from the stored tail, yet every one is keyed (the repeat is indexed).
    expect(leg.executionIdentity?.result.output).not.toContain('TS2322');
    expect(leg.errorKeys).toEqual(['lib/a.ts|TS2322', 'lib/a.ts|TS2322#2', 'lib/b.ts|TS2345']);
    // A passing leg carries no keys.
    expect(legs.records.filter((record) => record.status === 'passed').every((record) => record.errorKeys === undefined)).toBe(true);
  });
  it('runs a discoverable set of npm-script legs on the happy path', async () => {
    const { legs, invokedScripts } = await runLegs(null);
    // Sanity: the chain really ran (a zero-leg run would make every assertion below vacuous
    // — the same "green because nothing was measured" failure this file guards against).
    expect(invokedScripts.length).toBeGreaterThan(5);
    expect(legs.ok).toBe(true);
    expect(legEntries(legs).some(([, l]) => l.status === 'failed')).toBe(false);
  });

  it('EI-203121: records bounded execution identity for every measured leg', async () => {
    const exec: CheckpointExec = async (cmd) =>
      cmd === 'git'
        ? { code: 1, stdout: '', stderr: '' }
        : { code: 0, stdout: 'result-tail-'.repeat(250), stderr: '' };
    const legs = await runPostSuiteLegs(ROOT, process.env, exec, '@papercusp/operator-vite', {
      identity: {
        runId: 'r'.repeat(200),
        candidate: 'c'.repeat(80),
        headAtStart: 'h'.repeat(80),
        setup: {
          identity: 'setup-identity-'.repeat(30),
          output: 'setup-output-'.repeat(200),
        },
      },
    });

    expect(legs.records.length).toBeGreaterThan(5);
    for (const record of legs.records) {
      const identity = record.executionIdentity;
      expect(identity, `${record.id} must identify the tree and command result it judged`).toBeDefined();
      expect(identity?.runId).toHaveLength(128);
      expect(identity?.candidate).toHaveLength(64);
      expect(identity?.headAtStart).toHaveLength(64);
      expect(identity?.treeDir).toBe(ROOT);
      expect(identity?.cwd).toBe(ROOT);
      expect(identity?.dependencies.nodeModules.source).toBe(join(ROOT, 'node_modules'));
      expect(identity?.setup.identity.length).toBeLessThanOrEqual(200);
      expect(identity?.setup.output.length).toBeLessThanOrEqual(1000);
      expect(identity?.result.status).toBe(record.status);
      expect(identity?.result.output.length).toBeLessThanOrEqual(2000);
    }
  });

  it('reds the verdict for EVERY leg script that can fail (no leg excluded from legs.ok)', async () => {
    const { legs: happy, invokedScripts } = await runLegs(null);
    const scripts = [...new Set(invokedScripts)];

    /** Legs that actually RAN on this tree — the population that must be provably red-able.
     *  A leg whose script is absent from the candidate is legitimately 'skipped' forever and
     *  is not something this test can (or should) exercise. */
    const ranLegs = legEntries(happy)
      .filter(([, l]) => l.status === 'passed')
      .map(([name]) => name);
    /** Legs observed going 'failed' at least once during the sweep below. */
    const provenRedable = new Set<string>();

    const escaped: { script: string; failedLegs: string[]; skippedAfter: string[] }[] = [];
    for (const script of scripts) {
      const { legs } = await runLegs(script);
      const failed = legEntries(legs)
        .filter(([, l]) => l.status === 'failed')
        .map(([name]) => name);
      for (const name of failed) provenRedable.add(name);
      if (failed.length > 0 && legs.ok !== false) {
        escaped.push({
          script,
          failedLegs: failed,
          // What a `haltedBy` short-circuit silently dropped on the way past the verdict.
          skippedAfter: legEntries(legs)
            .filter(([, l]) => l.status === 'skipped' && l.skipReason?.includes(script))
            .map(([name]) => name),
        });
      }
    }

    expect(
      escaped,
      `These npm scripts FAILED a post-suite leg but left legs.ok true — the gate would report ` +
        `GREEN on their red (and skip every later leg). Add the leg field to the legs.ok ` +
        `aggregation in runPostSuiteLegs:\n${JSON.stringify(escaped, null, 2)}`,
    ).toEqual([]);

    // ANTI-VACUITY. The sweep above only proves what it actually exercised: if a leg never
    // went 'failed' in any iteration, the assertion passed WITHOUT saying anything about it,
    // and a leg missing from legs.ok would sail straight through. Require that every leg
    // which RAN was observed reddening — so the guard's coverage is measured, not assumed.
    expect(
      ranLegs.filter((name) => !provenRedable.has(name)),
      `These legs RAN but were never observed failing, so the assertion above proves NOTHING ` +
        `about them — the sweep could not reach them by failing a single npm script (a leg ` +
        `keyed off a non-npm command, or one sharing a script name). Extend runLegs() so each ` +
        `is exercised; do not delete this check.`,
    ).toEqual([]);
  });

  // P-026 item (b). Named deliberately, unlike the property-anchored sweeps above: that this
  // PARTICULAR guard gates promotion is the deliverable, not an incidental instance. Its only
  // blocking path used to be .github/workflows/test.yml (push/PR to `main` + this gate's own
  // POST-fast-forward dispatch), both downstream of promotion — so an unclassified timer was
  // invisible for its whole life on staging and only red once already promoted.
  it('gates lint:timer-classification BEFORE promotion, and its red holds the gate', async () => {
    const { legs: happy, invokedScripts } = await runLegs(null);
    expect(invokedScripts).toContain('lint:timer-classification');
    expect(happy.lintTimerClassification.status).toBe('passed');

    const { legs } = await runLegs('lint:timer-classification');
    expect(legs.lintTimerClassification.status).toBe('failed');
    expect(legs.ok).toBe(false);
    expect(legs.failingSignatures).toContain('lint:timer-classification');
  });

  // EI-19962933556828227: the sibling gap to the one above — `lint:no-raw-setinterval` had
  // the SAME only-blocking-path-is-inert-CI shape (.github/workflows/test.yml push/PR to
  // `main`), so an offender committed to `staging` was invisible for its whole life there
  // and only reddened AFTER promotion. Named deliberately for the same reason as the
  // timer-classification test above: that THIS guard gates promotion is the deliverable.
  it('gates lint:no-raw-setinterval BEFORE promotion, and its red holds the gate', async () => {
    const { legs: happy, invokedScripts } = await runLegs(null);
    expect(invokedScripts).toContain('lint:no-raw-setinterval');
    expect(happy.lintNoRawSetinterval.status).toBe('passed');

    const { legs } = await runLegs('lint:no-raw-setinterval');
    expect(legs.lintNoRawSetinterval.status).toBe('failed');
    expect(legs.ok).toBe(false);
    expect(legs.failingSignatures).toContain('lint:no-raw-setinterval');
  });

  /* ── the tip rescue must be able to re-run every signature this file can emit ──────────
   *
   * EI-19992136440423793. Reddening the gate (the sweeps above) and being able to MEASURE
   * whether that red is stale are two different properties, and only the first was guarded.
   * `nonTestGateIdsFrom` admits a failing entry only if it is a NON_TEST_GATE_SCRIPTS key or a
   * self-describing `<ws> :: lint:<name>` task id — and it is ALL-OR-NOTHING (`ids.every`), so
   * ONE unadmitted signature vetoes the tip re-run for every admissible sibling beside it.
   *
   * A ROOT-level lint leg is admissible only by hand-registration, so adding one is a silent
   * two-step: wire the leg (guarded above) and remember to register it (guarded by NOTHING
   * until now). Measured cost of the gap on 2026-08-12: `lint:no-raw-setinterval` was wired but
   * unregistered, so a red on ['lint:mock-cast-escape','lint:no-raw-setinterval'] — whose
   * offending bare setInterval() was ALREADY removed at tip — could not be re-verified, and the
   * gate reached 19 consecutive reds with `main` frozen behind it.
   *
   * Property-anchored like its siblings: the signatures are DISCOVERED by failing each script in
   * turn, so a new leg is covered the moment it is wired, with no edit here. */
  const RESCUE_EXCLUDED = new Set([
    // Not a gate id and not re-runnable by construction: the CANDIDATE's package.json could not
    // be read, so there is no script to re-run. Re-running anything at tip would answer a
    // different question than the one the red asked.
    'package.json-unreadable',
  ]);

  it('every failing-signature a leg can emit is re-runnable by the tip rescue', async () => {
    const { invokedScripts } = await runLegs(null);
    const scripts = [...new Set(invokedScripts)];

    const signatures = new Set<string>();
    for (const script of scripts) {
      const { legs } = await runLegs(script);
      for (const sig of legs.failingSignatures ?? []) signatures.add(sig);
    }

    // ANTI-VACUITY, twice over. An empty/tiny signature set would make the assertion below pass
    // while proving nothing (the same "green because nothing was measured" shape this file
    // exists to catch), and a predicate that returned true for everything would too.
    expect(signatures.size).toBeGreaterThan(5);
    // The sentinel must be an entry the predicate genuinely MUST reject. It used to be
    // 'lint:deliberately-not-registered-anywhere', which stopped discriminating on 2026-09-09
    // (6710ce37): that commit made a TYPED ROOT lint entry re-runnable by name — the last line
    // of isRerunnableGateEntry now admits any `lint:` / `seed:` prefix deliberately, since such
    // an entry carries its exact script as its id. So the old sentinel was asserting the
    // OPPOSITE of the documented contract and red-pinned this file for two days. Use an entry
    // that is neither a registry key, nor a `<ws> :: <script>` task id, nor a typed root
    // lint/seed entry — which is what "the predicate is not constant-true" actually requires.
    expect(isRerunnableGateEntry('deliberately-not-registered-anywhere')).toBe(false);
    // Pin the admission that replaced it, so the line above cannot silently drift back into
    // contradicting the predicate: a typed root lint entry IS rescue-eligible by name.
    expect(isRerunnableGateEntry('lint:deliberately-not-registered-anywhere')).toBe(true);

    const unrescuable = [...signatures].filter(
      (sig) => !isRerunnableGateEntry(sig) && !RESCUE_EXCLUDED.has(sig),
    );

    expect(
      unrescuable,
      `These leg failing-signatures cannot be re-run at tip, so a red naming ANY of them is ` +
        `unmeasurable for staleness — and because nonTestGateIdsFrom() is all-or-nothing, each ` +
        `one also VETOES the rescue for every admissible signature failing beside it:\n` +
        `${JSON.stringify(unrescuable, null, 2)}\n\n` +
        `Fix by registering each in NON_TEST_GATE_SCRIPTS (green-checkpoint.ts). A root lint ` +
        `script qualifies on that registry's own bar: one fast, deterministic, repo-wide script ` +
        `with no PG or network dependency. If a signature genuinely cannot be re-verified that ` +
        `way, add it to RESCUE_EXCLUDED above WITH the reason it is not re-runnable — never ` +
        `delete this check, which is the only thing standing between a new lint leg and another ` +
        `un-rescuable red streak.`,
    ).toEqual([]);
  });
});

/**
 * WI-37485: a MISSING `lint:tsc` must not silently disable the gate's only operator-core
 * typecheck.
 *
 * `checkNpmScript(treeDir,'lint:tsc') === 'absent'` is the ONE branch that skips this leg
 * while setting no `haltedBy`, pushing no failing signature, and — since runPostSuiteLegs
 * persists a non-test leg's output only on failure — writing nothing to the log. WI-37485
 * observed a candidate whose later legs ran (proving the operator-core leg had not halted
 * the chain) while that candidate provably contained a TS2741, and could not settle whether
 * this branch had fired, because a tree taking it leaves no artifact behind.
 *
 * `absent` must STAY silent for a real subject hive, so the tests below pin BOTH directions:
 * the root-shaped tree fails loudly, the hive-shaped tree still skips quietly. Every tree
 * here is built in a TEMP DIR (`runPostSuiteLegs` takes `treeDir` as a parameter), so this
 * never mutates the shared checkout — the copy-out tier of CLAUDE.md's falsifiability rule.
 */
describe('green-checkpoint — a missing lint:tsc cannot silently skip the typecheck leg (WI-37485)', () => {
  /** Build a throwaway tree exposing exactly `scripts`, optionally CONTAINING the
   *  operator-core tsc project, and run the real leg chain on it. */
  function makeTree(scripts: Record<string, string>, withOperatorCore: boolean) {
    const dir = mkdtempSync(join(tmpdir(), 'gc-wi37485-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'probe-tree', scripts }));
    if (withOperatorCore) {
      const project = join(dir, OPERATOR_CORE_TSCONFIG_RELPATH);
      mkdirSync(dirname(project), { recursive: true });
      writeFileSync(project, JSON.stringify({ include: ['lib/**/*.ts'] }));
    }
    return dir;
  }

  async function runLegsInTree(scripts: Record<string, string>, withOperatorCore: boolean) {
    const dir = makeTree(scripts, withOperatorCore);
    try {
      const invokedScripts: string[] = [];
      const exec: CheckpointExec = async (cmd, args) => {
        const script = npmScriptOf(cmd, args);
        if (script) invokedScripts.push(script);
        if (cmd === 'git') return { code: 1, stdout: '', stderr: '' };
        return ok;
      };
      const legs = await runPostSuiteLegs(dir, process.env, exec, '@papercusp/operator-vite');
      return { legs, invokedScripts };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** A sibling typecheck leg a SUBJECT HIVE may legitimately ship without `lint:tsc`
   *  (green-checkpoint-real-deps' `libsTypecheckTree` pins exactly this). Present in the
   *  hive-shaped trees below so the guard is forced to ignore it. */
  const HIVE_SIBLING = { 'lint:tsc:papercusp-libs': 'echo libs' };

  it('FAILS loudly when the candidate CONTAINS operator-core but exposes no lint:tsc', async () => {
    const { legs, invokedScripts } = await runLegsInTree(HIVE_SIBLING, true);

    expect(
      legs.typecheck?.status,
      'A candidate carrying packages/operator-core with no `lint:tsc` must FAIL the typecheck ' +
        'leg, not skip it — skipping is what made WI-37485 unfalsifiable.',
    ).toBe('failed');
    expect(
      legs.ok,
      'A failed typecheck leg must red the verdict through legs.ok, or the gate reports GREEN ' +
        'on a candidate whose operator-core typecheck never ran.',
    ).toBe(false);
    // It must not have HALTED the chain: later legs still have to run and report.
    expect(invokedScripts).toContain('lint:tsc:papercusp-libs');
  });

  it('still SKIPS silently for a subject hive — even one shipping lint:tsc:papercusp-libs', async () => {
    // The legitimate case `absent` exists for, and the exact shape that broke the first
    // attempt at this guard: green-checkpoint-real-deps' `libsTypecheckTree` provides the
    // libs leg WITHOUT `lint:tsc` and must stay green.
    const { legs } = await runLegsInTree(HIVE_SIBLING, false);

    expect(legs.typecheck?.status).toBe('skipped');
    expect(
      legs.ok,
      'A subject hive legitimately has no operator-core typecheck; it must not be failed for that.',
    ).not.toBe(false);
  });

  it('CALIBRATION: the same operator-core-bearing tree WITH lint:tsc does not trip the guard', async () => {
    // Without this, the first test would also pass if the guard failed the leg unconditionally.
    const { legs } = await runLegsInTree({ 'lint:tsc': 'echo tsc', ...HIVE_SIBLING }, true);

    expect(legs.typecheck?.status).toBe('passed');
    expect(legs.ok).not.toBe(false);
  });

  it('CONTROL: the OLD rule provably could not tell these two trees apart', () => {
    // Permanent falsifiability control (CLAUDE.md: for a MODULE you import, keep the
    // deliberately-wrong implementation in the test rather than mutating the shared tree).
    //
    // The pre-WI-37485 code branched on `checkNpmScript(...) === 'absent'` ALONE and skipped
    // silently. This asserts BOTH trees land on that same 'absent' input — so the old rule
    // mapped them to the identical silent skip and could not have failed either — while the
    // tests above show the new discriminator gives them OPPOSITE verdicts. Without this, a
    // future refactor could make the root-shaped tree fail for an unrelated reason (say an
    // 'unreadable' package.json) and the test above would still pass, proving nothing.
    const withCore = makeTree(HIVE_SIBLING, true);
    const withoutCore = makeTree(HIVE_SIBLING, false);
    try {
      // The exact input the old branch saw — IDENTICAL for both trees, so the old rule
      // mapped both to the same silent skip and could not have failed either.
      expect(checkNpmScript(withCore, 'lint:tsc')).toBe('absent');
      expect(checkNpmScript(withoutCore, 'lint:tsc')).toBe('absent');

      // The trees are also identical in their SCRIPTS, so nothing script-shaped can be
      // doing the work — the only difference is the presence of the checked project.
      expect(checkNpmScript(withCore, 'lint:tsc:papercusp-libs')).toBe('present');
      expect(checkNpmScript(withoutCore, 'lint:tsc:papercusp-libs')).toBe('present');

      // ...and that is the only thing separating them.
      expect(existsSync(join(withCore, OPERATOR_CORE_TSCONFIG_RELPATH))).toBe(true);
      expect(existsSync(join(withoutCore, OPERATOR_CORE_TSCONFIG_RELPATH))).toBe(false);
    } finally {
      rmSync(withCore, { recursive: true, force: true });
      rmSync(withoutCore, { recursive: true, force: true });
    }
  });

  it('OPERATOR_CORE_TSCONFIG_RELPATH names a project that really exists in this repo', () => {
    // Anchors the constant to the tree instead of to a string literal: if operator-core's
    // tsconfig is ever moved or renamed, this path silently stops matching and the guard
    // degrades to "never fires" with every test above still green — the same
    // weakens-to-vacuous failure the legs.ok sweep guards against.
    expect(
      existsSync(join(ROOT, OPERATOR_CORE_TSCONFIG_RELPATH)),
      `${OPERATOR_CORE_TSCONFIG_RELPATH} does not exist in this repo, so the WI-37485 guard can ` +
        `never fire. Re-point OPERATOR_CORE_TSCONFIG_RELPATH at the project lint:tsc checks.`,
    ).toBe(true);
    // And the real root is the shape the guard expects: it HAS the project AND the script,
    // so the guard must be silent on it (a root that tripped its own guard would red main).
    expect(checkNpmScript(ROOT, 'lint:tsc')).toBe('present');
  });
});
