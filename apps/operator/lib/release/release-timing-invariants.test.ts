/**
 * The green-gate timing chain — the recurrence guard for WI-6112.
 *
 * Four constants bound one green-checkpoint run, and they live in THREE files across
 * TWO workspaces because operator-core cannot import from apps/operator. Each file
 * carried a prose "whoever retunes one must retune the others" note, and nothing
 * enforced it — so when the suite budget was raised 55m→120m (EI-7553) the DBOS
 * reaper's no-output window stayed at 60m and silently became the TIGHTEST bound in
 * the chain: it cancelled the bookkeeping row of healthy 60–90m runs while their own
 * timeout still had 30m to go, re-arming the 2026-06-29 "reaper kills a healthy
 * checkpoint" incident that freezes `main` (→ every fleet deploy) for hours.
 *
 * This test is the missing enforcement. It is deliberately a pure-constant assertion
 * with no I/O: it is cheap enough to run in the affected-tests loop, and it fails at
 * EDIT time rather than at the next multi-hour gate freeze.
 *
 * ⚠ TWO DIFFERENT PROBLEMS LIVE IN THIS FILE, and only one of them is this test's to
 * solve. The four links above are four GENUINELY DIFFERENT numbers whose ORDERING is a
 * design decision — no import can enforce that, so it is asserted here. What was ALSO
 * asserted here for a while was that three other constants held the same value as the
 * suite budget; those were hand-typed copies, made necessary by a module-load side
 * effect in the budget's old home. WI-39841's follow-on removed the side effect
 * (`operator-core/lib/release/green-checkpoint-schedule.ts` is a leaf with no imports),
 * so those three now IMPORT the budget and the drift is impossible rather than detected.
 * When you are tempted to add an assertion here, ask which of the two you have: a real
 * ordering decision belongs in this file; two names for one number belongs in an import.
 *
 * If you are here because this test just went red: do not "fix" it by nudging one
 * number until it passes. Read the chain below, decide which link genuinely needs to
 * move, and move the OTHERS to keep the ordering — the whole point is that these four
 * numbers are one decision, not four.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS,
  NO_OUTPUT_OVERRIDE_CEILING_MS,
  NO_OUTPUT_OVERRIDE_FLOOR_MS,
} from "@papercusp/operator-core/lib/dbos/dbos-executor-reaper";
import {
  GREEN_CHECKPOINT_CRON,
  greenCheckpointCronForInstall,
  GREEN_CHECKPOINT_FIRE_PERIOD_MS,
  GREEN_CHECKPOINT_PHASE_MARGIN_MS,
  GREEN_CHECKPOINT_SUITE_TIMEOUT_MS,
} from "@papercusp/operator-core/lib/release/green-checkpoint-schedule";
import {
  CHECKPOINT_MAX_RUNTIME_SEC,
  MANUAL_CHECKPOINT_WATCHDOG_ENV,
  MANUAL_CHECKPOINT_WATCHDOG_MS,
  REPLACE_STALE_MIN_SILENCE_SEC,
} from "@papercusp/operator-core/lib/release-checkpoint-launch";

import {
  CHECKPOINT_LOCK_STALE_MS,
  DEFAULT_REFIRE_RUN_BUDGET_MS,
  ISOLATION_PHASE_RESERVE_MS,
  ISOLATION_RUN_TIMEOUT_MS,
  MANUAL_SELF_WATCHDOG_ENV,
  MIN_MANUAL_SELF_WATCHDOG_MS,
  SELF_WATCHDOG_MS,
} from "./green-checkpoint";

const MIN = 60_000;
const m = (ms: number) => `${Math.round(ms / MIN)}m`;

type Link = readonly [name: string, ms: number];

/** The whole chain, in the order a single run passes through it. */
const CHAIN: readonly Link[] = [
  [
    "GREEN_CHECKPOINT_SUITE_TIMEOUT_MS (release/green-checkpoint-schedule.ts)",
    GREEN_CHECKPOINT_SUITE_TIMEOUT_MS,
  ],
  ["SELF_WATCHDOG_MS (green-checkpoint.ts)", SELF_WATCHDOG_MS],
  [
    "DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS (dbos-executor-reaper.ts)",
    DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS,
  ],
  ["CHECKPOINT_LOCK_STALE_MS (green-checkpoint.ts)", CHECKPOINT_LOCK_STALE_MS],
];

/**
 * Returns a human-readable report of the FIRST place the chain stops increasing, or
 * null when it is strictly monotonic. Pure + exported-shaped on purpose: the test below
 * feeds it the historical BROKEN configuration, so this guard is itself guarded — an
 * always-green detector would silently stop protecting the gate.
 */
function firstInversion(chain: readonly Link[]): string | null {
  for (let i = 1; i < chain.length; i += 1) {
    const [prevName, prev] = chain[i - 1];
    const [name, cur] = chain[i];
    if (cur <= prev) {
      // Report the WHOLE chain — the link that moved is rarely the one to fix.
      const rendered = chain.map(([n, ms]) => `${n} = ${m(ms)}`).join("\n  ");
      return (
        `${name} (${m(cur)}) must be STRICTLY GREATER than ${prevName} (${m(prev)}).\n` +
        `The gate's timing chain is:\n  ${rendered}\n` +
        "See the INVARIANT comments on all four constants before changing any of them."
      );
    }
  }
  return null;
}

describe("green-gate timing chain (WI-6112)", () => {
  it("is strictly monotonic: suite timeout < self-watchdog < reaper no-output < lock stale", () => {
    expect(firstInversion(CHAIN)).toBeNull();
  });

  it("detects the historical inversion it exists to prevent", () => {
    // The exact live configuration on 2026-07-26: the suite budget had been raised to
    // 120m but the reaper's window was still the pre-bump 60m, so the reaper was the
    // tightest link and cancelled healthy runs. If this ever returns null, the detector
    // above has been broken and the real chain is no longer protected.
    const historical: readonly Link[] = [
      ["GREEN_CHECKPOINT_SUITE_TIMEOUT_MS (release-actions.ts)", 120 * MIN],
      ["SELF_WATCHDOG_MS (green-checkpoint.ts)", 180 * MIN],
      [
        "DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS (dbos-executor-reaper.ts)",
        60 * MIN,
      ],
      ["CHECKPOINT_LOCK_STALE_MS (green-checkpoint.ts)", 190 * MIN],
    ];
    const report = firstInversion(historical);
    expect(report).not.toBeNull();
    expect(report).toContain("DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS");
    // …and it must also catch an EQUAL pair, not just a smaller one.
    expect(
      firstInversion([
        ["a", 5 * MIN],
        ["b", 5 * MIN],
      ]),
    ).not.toBeNull();
  });

  it("gives the reaper a window ABOVE the whole run, not merely above the suite timeout", () => {
    // The reaper's window is a WALL-CLOCK CAP FROM WORKFLOW CREATION, not a
    // since-last-output silence timer (verified 2026-07-26 against the predicate:
    // `created_at < now - window` AND "no operation_outputs row with function_id > 0").
    // The suite writes NO DBOS step checkpoint until its single step returns, however
    // chattily it logs to disk — so a healthy run only escapes reaping by FINISHING
    // inside this window. A parent-dead run is not killed until its own self-watchdog
    // fires, so the window must clear the watchdog too, not just the suite timeout.
    expect(DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS).toBeGreaterThan(
      SELF_WATCHDOG_MS,
    );
    expect(DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS).toBeGreaterThan(
      GREEN_CHECKPOINT_SUITE_TIMEOUT_MS,
    );
  });

  it("frees the DBOS dedup pin before the run-lock becomes reclaimable", () => {
    // Ordering rationale for the last link: cancelling the non-terminal fire releases
    // the `routine:<id>` dedup pin, which is what lets the routine be requeued. If the
    // lock became stale-reclaimable FIRST, a peer could take the lock while the routine
    // was still dedup-pinned — a reclaimable lock with no fire able to use it.
    expect(DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS).toBeLessThan(
      CHECKPOINT_LOCK_STALE_MS,
    );
  });

  it("leaves the reaper enough margin to actually fire inside that gap", () => {
    // The reaper sweeps every DEFAULT_REAP_INTERVAL_MS (2m), so it observes a row up to
    // one interval AFTER the window elapses. That late observation must still land below
    // the lock-stale threshold, or the ordering above holds on paper and inverts in
    // practice. Two sweeps of headroom keeps it honest under host CPU pressure.
    const sweepHeadroom = 2 * 2 * MIN;
    expect(
      CHECKPOINT_LOCK_STALE_MS - DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS,
    ).toBeGreaterThanOrEqual(sweepHeadroom);
  });

  it("puts no wall-clock budget on refires by default (WI-6554700010042457, was EI-19343532231631821)", () => {
    // The refire budget used to sit just under the suite-timeout kill so a refire never started
    // into it (EI-19343532231631821). Avi #2574 removed that kill from the main-greening path, so
    // the budget's only remaining effect would be to stop a healthy run before its verdict.
    // Recursion stays bounded by COUNT (refireAbsoluteCeiling), never by the clock.
    expect(DEFAULT_REFIRE_RUN_BUDGET_MS).toBe(Number.POSITIVE_INFINITY);
  });

  /**
   * WI-38026 (2026-08-12) — the EXTERNAL link in the same chain, and the one that was missing.
   *
   * The four constants above bound what the run does to ITSELF. The replace threshold
   * bounds when someone ELSE may kill it, and it was a hand-written `20 * 60` that nothing
   * tied to the rest of the chain — six times tighter than the suite budget. So a healthy run
   * became "replaceable" ~20 min into a suite allowed to take 120, and with several agents
   * independently reacting to one red gate, three consecutive runs were SIGTERMed mid-suite
   * (1317s, 1358s, each "a replaceStale before producing a verdict"). Zero verdicts landed,
   * `main` stayed frozen 6.5h, and the tests the gate named had ALREADY been fixed in the
   * tree — the gate was simply never allowed to finish judging them.
   *
   * The invariant: a run still inside its own suite budget is not wedged, so replacement
   * cannot unlock before that budget is spent.
   *
   * WI-6554700010042457 restated it for a run with no wall clock: the threshold is SILENCE
   * (REPLACE_STALE_MIN_SILENCE_SEC), and it is exactly the run's own idle budget. A peer may
   * replace a run only once it has been quiet as long as its own watchdog would tolerate.
   */
  it("does not let a peer kill a run that is still inside its own idle budget (WI-38026)", () => {
    expect(REPLACE_STALE_MIN_SILENCE_SEC * 1000).toBeGreaterThanOrEqual(
      MANUAL_CHECKPOINT_WATCHDOG_MS,
    );
    expect(REPLACE_STALE_MIN_SILENCE_SEC * 1000).toBeGreaterThanOrEqual(
      GREEN_CHECKPOINT_SUITE_TIMEOUT_MS,
    );
  });

  /**
   * EI-20669541349219660 — the isolation phase must be able to PLAN around the kill.
   *
   * The phase deadline is derived from the ACTUAL killer. WI-6554700010042457 removed the
   * scheduled parent's suite-budget group-kill (the old SUITE_KILL_BUDGET_MIRROR_MS), so the
   * only killer left is a deadline a caller transports; isolationPhaseDeadlineMs stops starting
   * work this reserve before it (and is unbounded without one — pinned in green-checkpoint.test).
   */
  it("the phase reserve covers one in-flight isolation attempt plus verdict-write margin (EI-20669541349219660)", () => {
    expect(ISOLATION_PHASE_RESERVE_MS).toBeGreaterThanOrEqual(
      ISOLATION_RUN_TIMEOUT_MS + MIN,
    );
  });

  it("gives detached manual runs the scheduled full kill window instead of the 3h orphan backstop", () => {
    // The env NAME is still genuinely duplicated across the launcher/CLI boundary — it is a
    // string protocol between two processes, not a shared constant — so this guard is what
    // makes it a checked protocol rather than a prose convention.
    //
    // The VALUE is no longer duplicated: both sides derive it from the schedule leaf. The
    // `+ 15_000` here is written out on purpose rather than imported, so this line states the
    // grace INDEPENDENTLY of the code under test. Import it and the assertion becomes true by
    // construction and stops being able to notice a changed grace period at all.
    expect(MANUAL_CHECKPOINT_WATCHDOG_ENV).toBe(MANUAL_SELF_WATCHDOG_ENV);
    expect(MANUAL_CHECKPOINT_WATCHDOG_MS).toBe(
      GREEN_CHECKPOINT_SUITE_TIMEOUT_MS + 15_000,
    );
    expect(MIN_MANUAL_SELF_WATCHDOG_MS).toBe(MANUAL_CHECKPOINT_WATCHDOG_MS);
    expect(MANUAL_CHECKPOINT_WATCHDOG_MS).toBeLessThan(SELF_WATCHDOG_MS);
    expect(MANUAL_CHECKPOINT_WATCHDOG_MS).toBeLessThan(
      CHECKPOINT_MAX_RUNTIME_SEC * 1000,
    );
  });

  it("detects the historical replace-storm setting it exists to prevent", () => {
    // The literal value that shipped for months and starved the gate on 2026-08-12. If this
    // ever stops being a violation, the assertion above has been loosened into a no-op and
    // healthy runs are killable again — the same way the reaper inversion went unnoticed.
    const historicalReplaceStaleMinAgeSec = 20 * 60;
    expect(historicalReplaceStaleMinAgeSec * 1000).toBeLessThan(
      GREEN_CHECKPOINT_SUITE_TIMEOUT_MS,
    );
  });

  it("keeps replacement possible for a genuinely wedged run, below the lock-stale reclaim", () => {
    // The guard must not swing so far that replaceStale becomes unreachable: silent past its
    // own idle budget, a still-running process IS the EI-9672 salvage case, and it must be
    // stoppable before the lock would be reclaimed out from under it anyway.
    expect(REPLACE_STALE_MIN_SILENCE_SEC * 1000).toBeLessThan(
      CHECKPOINT_LOCK_STALE_MS,
    );
  });
});

/**
 * WI-39841. The chain above asks "does a run get killed before something else reclaims
 * its lock". This asks the question nothing was asking: WHEN, relative to the schedule,
 * does that kill land — because a run holds the exclusive run-lock right up to it.
 *
 * A scheduled run starts a second or two after its cron fire. So its deadline lands a
 * second or two after a LATER fire whenever the budget is an integer multiple of the
 * fire period, and that fire is refused by a run which is about to die anyway. The gate
 * then sits idle until the following period. At the old 120m against a 60m period this
 * was deterministic, not occasional, for every run that went the distance.
 *
 * Measured 2026-08-18: start 17:15:04.877Z, fire 19:15:01.941Z, SIGTERM 19:15:04
 * (journal `exited 143`), next run 20:15 — one over-long run cost ~2h of wall clock.
 */
describe("green-gate schedule phase (WI-39841)", () => {
  /**
   * How long a deadline-killed run dies BEFORE the next scheduled fire.
   *
   * A run starts ε (a second or two) after the fire that launched it, so measuring in
   * run-relative time, the fire boundaries sit at `k * period - ε`. The outer `% period`
   * is the whole point and the easy thing to get wrong: a budget that is an exact
   * multiple of the period has `timeout % period === 0`, which reads as "a full period
   * of slack" if you stop at the subtraction — when in fact the boundary lands ε INSIDE
   * the run and that fire is the one being refused. Folding it back to 0 states the real
   * quantity: zero slack.
   */
  const slackBeforeNextFireMs =
    (GREEN_CHECKPOINT_FIRE_PERIOD_MS -
      (GREEN_CHECKPOINT_SUITE_TIMEOUT_MS % GREEN_CHECKPOINT_FIRE_PERIOD_MS)) %
    GREEN_CHECKPOINT_FIRE_PERIOD_MS;

  it("kills a deadline-run far enough BEFORE a fire that the lock is free when it lands", () => {
    // Not merely "non-zero": a kill 30s ahead of a fire frees the lock on paper and loses
    // the slot in practice. The margin is what makes the recovered slot real.
    expect(slackBeforeNextFireMs).toBeGreaterThanOrEqual(
      GREEN_CHECKPOINT_PHASE_MARGIN_MS,
    );
  });

  it("buys that phase with the smallest possible cut to the budget", () => {
    // This fix must not become cover for shrinking the budget. 55m→120m (EI-7553) was paid
    // for because short budgets kill healthy runs pre-verdict; what is being bought here is
    // PHASE, not headroom. So the budget must sit at the LARGEST value that still clears the
    // boundary by the margin. Together with the guard above this pins it exactly — lowering
    // it further is a separate decision, and one that has to come and edit this line.
    expect(GREEN_CHECKPOINT_SUITE_TIMEOUT_MS).toBeGreaterThanOrEqual(
      2 * GREEN_CHECKPOINT_FIRE_PERIOD_MS - GREEN_CHECKPOINT_PHASE_MARGIN_MS,
    );
  });

  it("detects the historical phase-lock it exists to prevent", () => {
    // The exact live configuration through 2026-08-18: 120m against a 60m fire period — a
    // deadline landing dead on a fire boundary, zero slack. If this ever stops being a
    // violation, the guard above has been loosened into a no-op and the gate can quietly go
    // back to eating two slots per long run.
    const historicalTimeoutMs = 120 * MIN;
    const historicalSlackMs =
      (GREEN_CHECKPOINT_FIRE_PERIOD_MS -
        (historicalTimeoutMs % GREEN_CHECKPOINT_FIRE_PERIOD_MS)) %
      GREEN_CHECKPOINT_FIRE_PERIOD_MS;
    expect(historicalSlackMs).toBe(0);
    expect(historicalSlackMs).toBeLessThan(GREEN_CHECKPOINT_PHASE_MARGIN_MS);
  });
});

/**
 * The phase guard above is only as good as its premise: that GREEN_CHECKPOINT_CRON and
 * GREEN_CHECKPOINT_FIRE_PERIOD_MS describe the schedule the gate is ACTUALLY seeded with.
 *
 * That premise used to be prose. The cron was a bare literal re-typed at each seed site,
 * with a fourth copy exported for this file to read — so a seed site edited on its own
 * left every assertion here green while the real gate moved. Same failure mode as the
 * 55m→120m retune that stranded the DBOS reaper (see this file's header): a number that
 * looks like the source of truth and is really a copy.
 *
 * These two tests close that gap from both ends — the constant must describe an hourly
 * cron, and no seed site may carry its own copy of it.
 */
describe("green-gate schedule is single-sourced (WI-39841 follow-on)", () => {
  /** Repo root, from apps/operator/lib/release/<this file>. */
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

  /**
   * Every site that writes the green-checkpoint routine's trigger_config. Read with
   * readFileSync deliberately: a path that no longer resolves THROWS, rather than
   * scanning nothing and reporting a clean pass — the false-absence shape that makes a
   * source-scanning guard worse than no guard at all.
   */
  const SEED_SITES = [
    "packages/operator-core/lib/harness/routines/seed-hive-release-routines.ts",
    "apps/operator/lib/release/seed-release-routines.ts",
    "apps/operator/lib/release/retrofit-hive-to-gate.ts",
  ] as const;

  it("states a cron that really does fire once per GREEN_CHECKPOINT_FIRE_PERIOD_MS", () => {
    // `sec min * * * *` — a fixed second and minute, every hour, every day. Anything else
    // (a step, a list, a range, a narrower day/month field) fires on a DIFFERENT period,
    // and the whole phase calculation above is then computed against a fiction. This is
    // deliberately a shape assertion and not a cron parser: the useful outcome is that
    // someone changing the schedule is forced to come here and re-derive the period, not
    // that this file learns to evaluate arbitrary crons.
    expect(GREEN_CHECKPOINT_CRON).toMatch(/^\d{1,2} \d{1,2} \* \* \* \*$/);
    expect(GREEN_CHECKPOINT_FIRE_PERIOD_MS).toBe(60 * MIN);
  });

  it("deterministically spreads the observed multi-pot fleet across the hour", () => {
    const installs = [
      'papercusp-public-site', 'hello-world-2-hive', 'spoon-knife-hive', 'quartermaster',
      'oddsmith', 'stonebrook-android', 'panda-gallery', 'hello-world-3',
      'thornbury-iphone', 'hello-world-hive', 'hotel-reservations', 'scout-runtime',
      'hello-world-3-pot', 'papercusp-public-site-pot', 'calendar', 'quartermaster-hive',
      'email', 'dummy-pot-0707', 'readinglist', 'sidestage',
    ];
    const crons = installs.map(greenCheckpointCronForInstall);
    expect(new Set(crons).size).toBe(installs.length);
    expect(crons.every((cron) => /^\d{1,2} \d{1,2} \* \* \* \*$/.test(cron))).toBe(true);
    expect(greenCheckpointCronForInstall('oddsmith')).toBe(greenCheckpointCronForInstall('oddsmith'));
  });

  it("is the ONLY place the gate's cron literal appears", () => {
    const offenders = SEED_SITES.filter((site) =>
      readFileSync(join(repoRoot, site), "utf8").includes(GREEN_CHECKPOINT_CRON),
    );

    // Note what is NOT asserted: that the literal appears nowhere in the repo.
    // `autoloop-release-readiness-monitor` independently chose the same slot and is
    // deliberately not wired to this constant (see its seed script) — a repo-wide ban
    // would force a wrong coupling to stay green.
    expect(offenders).toEqual([]);
  });
});

/**
 * THE SECOND COPY OF THE CRON DERIVATION — and why it is pinned here rather than imported.
 *
 * `greenCheckpointCronForInstall()` is reimplemented, deliberately, in
 * `libs/papercusp/libs/db/sql/976-stagger-green-checkpoint-crons.sql`, so that the rows the
 * migration already wrote and the rows a future re-seed writes converge on one schedule.
 * The TS function says exactly that in its own comment.
 *
 * This file's header asks which of two things a new assertion is: a real decision no import
 * can enforce, or two names for one number that should simply be an import. This is
 * emphatically the first, and not by preference — the second implementation is SQL inside an
 * applied-once migration. It cannot import the TypeScript, and it cannot be edited to follow
 * it either, because it has already run. The coupling has no mechanical enforcement
 * available to it except a test.
 *
 * WHY THE FAILURE IS WORTH GUARDING: it is silent and asymmetric. Migration 976 is frozen,
 * so the rows it wrote never move. Edit the weighting or the modulus in the TS and nothing
 * goes red — every FUTURE re-seed just lands on a different second of the hour than the
 * existing rows, leaving two populations of installs on divergent schedules. That is
 * precisely the staggering the migration existed to create, undone without a symptom.
 *
 * PROVENANCE OF THE VECTORS BELOW — the part that makes them worth anything. They are NOT
 * read back from `harness_shared.routines`, because live rows are circular evidence: a row
 * that had been re-seeded by the TypeScript would "confirm" the TypeScript against itself.
 * They were produced by executing migration 976's OWN expression in Postgres as a read-only
 * SELECT over a slug list, then compared against this function. Eleven of the twelve agreed
 * exactly — including the multi-byte UTF-8 case and a 64-byte slug — and the twelfth is
 * recorded below as a real divergence rather than smoothed over.
 *
 * One thing that agreement is not an accident of: the TS reduces with `% 3_600` applied at
 * EVERY step, while the SQL applies `mod(sum(...), 3600)` once at the end. Those coincide
 * only because every term is non-negative — worth knowing before anyone "simplifies" either
 * side into the other's shape.
 */
describe("green-checkpoint cron derivation is pinned to migration 976 (EI-21810945709108727)", () => {
  /** Repo root, from apps/operator/lib/release/<this file>. */
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

  const MIGRATION_976 =
    "libs/papercusp/libs/db/sql/976-stagger-green-checkpoint-crons.sql";

  /**
   * install_slug → the cron migration 976's SQL derives for it, measured by executing that
   * expression in Postgres (2026-08-29). The first six are the live fleet's own installs, so
   * a regression here is simultaneously a statement about really-seeded rows.
   */
  const SQL_DERIVED: ReadonlyArray<readonly [string, string]> = [
    ["papercusp", "37 22 * * * *"],
    ["email", "10 26 * * * *"],
    ["scout-runtime", "24 40 * * * *"],
    ["readinglist", "8 59 * * * *"],
    ["quartermaster", "43 45 * * * *"],
    ["stonebrook-android-20260821", "8 45 * * * *"],
    ["a", "37 1 * * * *"],
    ["zz", "6 6 * * * *"],
    ["cafe-pot", "5 0 * * * *"],
    ["café-pot", "50 26 * * * *"],
    ["A".repeat(64), "20 33 * * * *"],
  ];

  it("derives exactly what migration 976's SQL derives", () => {
    for (const [slug, expected] of SQL_DERIVED) {
      expect(
        greenCheckpointCronForInstall(slug),
        `install_slug ${JSON.stringify(slug)}`,
      ).toBe(expected);
    }
  });

  it("documents the one input where the two derivations genuinely disagree", () => {
    // Empty slug: the SQL's generate_series spans zero rows, so sum() is NULL and the
    // migration would write the malformed cron "  * * * *". The TypeScript reduces an empty
    // byte array to its 0 seed and returns a well-formed top-of-the-hour cron. Unreachable
    // in practice — a routine's install_slug is never empty — and asserted here so the next
    // reader can see it was measured rather than missed.
    expect(greenCheckpointCronForInstall("")).toBe("0 0 * * * *");
  });

  it("still mirrors the SQL's load-bearing arithmetic", () => {
    // readFileSync, not a glob: a migration that has been renamed or deleted THROWS here
    // rather than scanning nothing and reporting a clean pass — the false-absence shape the
    // other source-scanning guard in this file calls out by name.
    const sql = readFileSync(join(repoRoot, MIGRATION_976), "utf8").replace(
      /\s+/g,
      " ",
    );

    expect(sql).toContain("3600");
    expect(sql).toContain("* (position + 1)");
    expect(sql).toMatch(/get_byte\(\s*convert_to\(/);
    expect(sql).toMatch(/mod\(\s*schedule\.second_of_hour,\s*60\s*\)/);
    expect(sql).toMatch(/floor\(\s*schedule\.second_of_hour\s*\/\s*60\.0\s*\)/);
  });
});

/**
 * EI-18734881428789368 — the bounds on the reaper's env override.
 *
 * The header above says an assertion here should be a real ordering decision, and that
 * "two names for one number belongs in an import". FLOOR/CEILING are two names for one
 * number — and the import it prescribes is the exact one this chain cannot have:
 * operator-core must not import from apps/operator, which is WHY SELF_WATCHDOG_MS and
 * CHECKPOINT_LOCK_STALE_MS live over here. So the reaper mirrors them as literals and
 * this is the pin that keeps the mirrors honest. Without it, moving a neighbour would
 * leave the override silently permitting a runtime value that inverts the chain — the
 * one hole a constant-only guard cannot see, because it asserts the CONSTANT while the
 * reaper runs on the env-resolved value.
 */
describe("reaper no-output override bounds (EI-18734881428789368)", () => {
  it("mirrors its un-importable neighbours exactly", () => {
    expect(NO_OUTPUT_OVERRIDE_FLOOR_MS).toBe(SELF_WATCHDOG_MS);
    expect(NO_OUTPUT_OVERRIDE_CEILING_MS).toBe(CHECKPOINT_LOCK_STALE_MS);
  });

  it("leaves a band that actually contains the default", () => {
    // Anti-vacuity: if the band excluded the default, every override would be refused and
    // the lever would be decorative — a guard reporting green while guarding nothing.
    expect(NO_OUTPUT_OVERRIDE_FLOOR_MS).toBeLessThan(
      DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS,
    );
    expect(DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS).toBeLessThan(
      NO_OUTPUT_OVERRIDE_CEILING_MS,
    );
  });

  it("accepts an in-band override and refuses one that would invert the chain", async () => {
    const load = async () => {
      vi.resetModules();
      return (
        await import("@papercusp/operator-core/lib/dbos/dbos-executor-reaper")
      ).STALE_ROUTINE_FIRE_NO_OUTPUT_MS;
    };
    const prev = process.env.PAPERCUSP_DBOS_REAPER_FIRE_NO_OUTPUT_MS;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const inBand = DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS + 60_000;
      process.env.PAPERCUSP_DBOS_REAPER_FIRE_NO_OUTPUT_MS = String(inBand);
      expect(await load()).toBe(inBand);

      // 60m: the exact historical value that made the reaper the tightest link and
      // cancelled healthy runs. The override must refuse to reproduce it, and must SAY so.
      process.env.PAPERCUSP_DBOS_REAPER_FIRE_NO_OUTPUT_MS = String(60 * 60_000);
      expect(await load()).toBe(DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("green-gate timing chain"),
      );
    } finally {
      warn.mockRestore();
      if (prev === undefined) {
        delete process.env.PAPERCUSP_DBOS_REAPER_FIRE_NO_OUTPUT_MS;
      } else {
        process.env.PAPERCUSP_DBOS_REAPER_FIRE_NO_OUTPUT_MS = prev;
      }
      vi.resetModules();
    }
  });
});

