/**
 * STATUS 2026-10-06 — WIRED AND RUNNING (gate-throughput-shift-left-2026-10-06, P-001).
 *
 *   This file is the PURE logic; the IO seams are `sync-batch-delta-check-deps.ts`, the
 *   action is `../harness/routines/sync-batch-delta-check-action.ts`, and the durable
 *   5-minute row is seeded by `seed-sync-batch-delta-check-routine.ts`. The old
 *   "UNWIRED, PARKED MID-BUILD" banner that stood here was stale: every step of the
 *   successor list below has landed. The list is kept as the wiring map.
 *
 *   What changed in P-001: the check no longer SKIPS under ordinary host load or
 *   while a green-checkpoint suite runs — that skip silently dropped most batches on
 *   this box, where load sits above 1.2x cores for most of the day. It now runs every
 *   heavy leg in the reserved `source-checks.slice` (`reservedCapacityArgv`, P-009 of
 *   green-main-ratchet-convergence-2026-10-17) and, under load or during a gate run,
 *   with a REDUCED confirm/attribution budget (`evaluateCapacity`). Load never skips it
 *   (D-017), and it records per-schedule-slot coverage with a 95%/24h alarm
 *   (`recordCoverageOpportunities` / `evaluateCoverage`). P-002: a confirmed red is ROUTED to the editing agent
 *   (`pickRedAuthor`).
 *
 *   Wiring map (all landed):
 *
 *   STILL TO DO for a successor (in this order — steps 2-5 must land in ONE change,
 *   because `routine-classification.registry.test.ts` cross-checks the registry
 *   against `TARGET_ROLE_SPEND` and reds the fleet gate on a half-landed pair):
 *     1. `sync-batch-delta-check-deps.ts` — bind `SyncBatchDeltaDeps` below to:
 *        `git -C <root> rev-parse <branch>` and `git log <cursor>..<branch>
 *        --first-parent --diff-merges=first-parent --name-only
 *        --format=%x00%H %ct%n%(trailers:key=Papercusp-Agent)` (first-parent since
 *        WI-6554700010018028: merged side lineages must not move the cursor)
 *        (argv spawn, never a shell string); `node scripts/affected-tests.mjs
 *        --changed-paths <csv> [--print-affected]`; `node scripts/lint-tsc.mjs
 *        --files=<csv>`; `node scripts/test-files.mjs <one file>` for `confirmOne`
 *        (read the `TEST_FILE_RESULT … status=` line — an ABSENT line or `matched=0`
 *        is `null`/undetermined, never `false`); `node scripts/proc-guard.mjs check
 *        green-checkpoint` for `greenCheckpointRunning` (exit 0 = running, 1 = not,
 *        2 = usage error ⇒ null); `/proc/loadavg` + `os.cpus().length` for `hostLoad`;
 *        `createOneWorkItem` from `agent-tools/work_items/_create-core` with
 *        `{ kind:'bug', severity:'major', harness:'papercusp', conditionKey }` for
 *        `fileRed` (assert `conditionUpsert.adopted` on the second filing);
 *        cursor read/write as a scoped `jsonb_set` on
 *        `harness_shared.routines.metadata.sync_delta` (precedent:
 *        `dead-target-sweep.ts`'s `stampHealth`).
 *     2. `../harness/routines/sync-batch-delta-check-action.ts` —
 *        `registerSystemAction('sync-batch-delta-check', …)`, lazy-importing the deps
 *        module (the `frozen-candidate-drift-sweep-action.ts` shape).
 *     3. import it from `../harness/routines/register-system-actions.ts`.
 *     4. classify it in `../automation/routine-classification.ts` as
 *        `'system:sync-batch-delta-check': { spend: 'none', why: … }` (it spawns no
 *        agent and wakes no session), and add `^sync-batch-delta-check$` to
 *        `GIT_RELEASE_FAMILY` there so it files under Git & release rather than Health.
 *     5. add `{ name: 'sync-batch-delta-check', seedScript:
 *        'seed-sync-batch-delta-check-routine.ts' }` to `BESPOKE_ACTIVE_SEEDS`
 *        (`../harness/routines/bespoke-active-seeds-check.ts`) in the SAME change as
 *        the seed script — that registry is what catches "the seed script nobody ran".
 *     6. `seed-sync-batch-delta-check-routine.ts` — a `tier:'durable'` cron row on the
 *        repo's 6-field cron (second-first), every 5 minutes, with
 *        `concurrency:'skip'` and `catchup:'skip-old'`, modelled on
 *        `seed-cargo-test-routine.ts`. Durable, NOT ephemeral: an
 *        ephemeral row seeded by a standalone tsx script is only armed at bg-host
 *        boot, which is exactly how `frozen-candidate-drift-sweep` sat at
 *        `last_fired_at IS NULL` indefinitely.
 *     7. tests: cursor advance, batch path union, red → conditionKey filing,
 *        load-skip — all expressible against `SyncBatchDeltaDeps` with plain fakes
 *        (no `vi.mock`, so the full-replacement-mock-guard cannot be tripped), plus
 *        one test pinning `parseFailingFilesLine` against the REAL emitter
 *        (`renderFailingFilesSummary` in `scripts/lib/vitest-summary.mjs`).
 *
 * ── (design notes below describe the finished shape, not the current wiring) ──
 *
 * The SYNC-BATCH DELTA CHECK — per-commit-batch verification of `staging`
 * (gate-verdict-liveness-and-repair-reliability-2026-08-31, P-012).
 *
 * ── The gap it closes ───────────────────────────────────────────────────────
 * `staging` takes ~800 commits/day from ~70-100 agents and NOTHING verifies any
 * of them. The only instrument is the hourly green-checkpoint, whose full suite
 * takes 55-115 min — so by the time a red is known, 40-226 files are failing and
 * attribution is gone. And attribution cannot be recovered after the fact: git-sync
 * sweeps the WHOLE tree under one identity, so `git blame` and the commit SUBJECT
 * both name the wrong agent (root CLAUDE.md). The only surviving attribution signal
 * is WHICH COMMIT'S CHANGED PATHS the break falls downstream of — and that signal
 * decays as batches pile up.
 *
 * So this samples the stream instead of the endpoint: every ~5 min, take the
 * commits that landed since a durable cursor, run the AFFECTED radius for their
 * union of changed paths, and — on a red — attribute it to the newest batch whose
 * radius can reach the failing file, then file ONE deduped work item naming that
 * batch and a 60-minute fix-or-revert SLA.
 *
 * ── Why the logic lives here and the IO lives in the action ─────────────────
 * Same split as `frozen-candidate-drift-sweep.ts`: every decision in this file is
 * pure and unit-tested; `../harness/routines/sync-batch-delta-check-action.ts`
 * binds it to git, the scripts, the routine cursor and the work-item store. A
 * lambdas-inside-a-closure shape has already cost this repo a load-bearing blind
 * spot (EI-21559794492221235) — a test can only pin the source text of an adapter
 * it cannot execute.
 *
 * ── Bounds, because an UNBOUNDED checker on this box IS the failure ─────────
 * Every leg is capped, and every cap fails toward doing LESS work:
 *   · host load over `cores * LOAD_SKIP_FACTOR`  ⇒ skip, record why, touch nothing;
 *   · green-checkpoint suite running             ⇒ skip (never fight the gate);
 *   · affected radius wider than the caps        ⇒ shrink to an older prefix; an
 *     individually oversized commit is recorded as non-evaluated and skipped alone;
 *   · red confirmation                           ⇒ at most MAX_CONFIRM_RUNS single-file runs;
 *   · batch attribution                          ⇒ at most MAX_ATTRIBUTION_PROBES radius probes.
 *
 * ── What it deliberately does NOT do ───────────────────────────────────────
 * No auto-revert, no notifications beyond the work item, no re-cutting or firing of
 * the gate. It is an OBSERVER that files evidence; the repair decision stays human
 * (or with the item's claimant).
 */

import type { KnownGoodPoint } from './known-good-freeze';
import { isAdmissionSyntheticCommitDate } from './admission-commit-date';
import { SCOPE_LAUNCH_FAILURE_RE, SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS } from '../systemd-scope';

// ── tunables (every default fails toward doing less work) ────────────────────

/** Above `loadavg1 > cores * this` the confirm/attribution budget shrinks to
 *  REDUCED_BUDGET. 1.2 = "the box is already oversubscribed". (The name is historical:
 *  before P-001 this line skipped the run.) */
export const LOAD_SKIP_FACTOR = 1.2;

/** Above `cores * this` the reduced budget's reason names the hard ceiling. Since
 *  green-main-ratchet-convergence-2026-10-17 P-009 (D-017) nothing skips here any more:
 *  the reserved slice bounds the check's share of the box, not a load threshold. */
export const HARD_LOAD_CEILING_FACTOR = 3;

/** How far before the oldest batch commit the edit ledger is searched. git-sync
 *  commits on a ~10-minute cadence, so an edit can precede its sweep by that much. */
export const EDITOR_LOOKBACK_MARGIN_MS = 30 * 60_000;

/** Confirm/attribution budget under load or while a gate suite runs. */
export const REDUCED_BUDGET = { maxConfirmRuns: 1, maxAttributionProbes: 3 } as const;

/** Fix-or-revert SLA quoted in the filed work item, in minutes. Deliberately shorter
 *  than the hourly gate cycle: the whole point is to repair before the next
 *  checkpoint freezes a candidate on top of the break. */
export const SYNC_DELTA_SLA_MINUTES = 60;

/** Radius caps. A prefix wider than any of these is narrowed to an older prefix.
 *  An individually oversized commit is explicitly skipped without running it, so
 *  a 71-workspace run can never become the "burning the box" outcome this avoids
 *  (the measured cost of an unscoped `test:affected`, EI-20812741760514969). */
export interface RadiusCaps {
  /** Affected WORKSPACES the probe may select before the batch is refused. */
  maxWorkspaces: number;
  /** Changed PATHS the union may carry before the batch is refused. */
  maxPaths: number;
  /** Commits one run may fold into a batch window before it is refused. */
  maxCommits: number;
  /** Exact runnable task commands the affected runner may select. Optional for
   *  callers that override only the original three dimensions. */
  maxTaskCommands?: number;
  /** Repo-wide invariant guards, a separately visible subset of task commands. */
  maxGuards?: number;
  /** D-030: when the probe emits a usable AFFECTED_ETA, admit by projected wall time
   *  instead of by task count. Seconds. */
  maxProjectedSec?: number;
  /** Count backstops that still apply on the projected-time path. */
  maxEtaTaskCommands?: number;
  maxEtaGuards?: number;
}

// Production coverage measured 2026-10-06 showed 15 of 17 radius refusals
// affected 7–10 workspaces. Keep the bound below the observed 20-workspace
// outlier while admitting those normal batches; the 80-path and 40-commit
// ceilings still bound the other dimensions independently.
// WI-10007175: the admitted 80-path prefix measured 10 workspaces, 64 task commands,
// and 52 guards; its affected child repeatedly hit the 25-minute timeout. Keep the
// admitted prefix below half those task/guard counts, and use the existing related
// selector in the runner to narrow test files when its evidence allows.
// green-main-ratchet-convergence-2026-10-17#D-030: the two count caps above are a proxy for
// TIME and were wrong both ways on a 14-commit sample (they refused 588s radii and admitted a
// ~1750s one). When the probe projects the radius's wall time, admission compares that
// projection with 0.9 x the affected leg budget (SYNC_DELTA_TIMEOUTS_MS.affected, derived
// below), and the count caps fall back to wide backstops.
// Without a projection the 32/26 count caps still apply.

/** Per-leg subprocess budgets. Generous for a quiet box, but bounded so a wedged
 *  child can never wedge the routines tick past the action's own deadline. They live here,
 *  not in the deps module (which re-exports them), because admission (maxProjectedSec) and
 *  the slot-credit deadline (COVERAGE_JUDGE_DEADLINE_MS) are DERIVED from them, and deps
 *  already imports this module (green-main-ratchet-convergence-2026-10-17#D-031). */
export const SYNC_DELTA_TIMEOUTS_MS = {
  git: 60_000,
  procGuard: 30_000,
  /** `--print-affected --related` is an enumeration — no test execution — but the related
   *  selector it runs (D-030, so the probe's AFFECTED_ETA describes the narrowed run) took
   *  ~4.4 min for one operator-core path under load on 2026-10-20, so 5 min was too tight. */
  probe: 10 * 60_000,
  /** The actual affected run, bounded by task/guard cardinality and narrowed by
   *  `--related` when the selector has positive evidence.
   *  green-main-ratchet-convergence-2026-10-17#D-034: 25 min was shorter than ONE commit's
   *  radius (measured 2026-10-20: single commits project 1176-1750s, one ran 25.6 min, one
   *  was killed at 1500s, one was refused at 1453s > 1350s), so most slots were never judged.
   *  Runs go back to back either way, so a longer budget does not raise the duty cycle; it
   *  stops discarding work that would have finished. Admission (maxProjectedSec), the
   *  slot-credit deadline, the stale-backlog cutoff and the routine timeout all derive from it. */
  affected: 45 * 60_000,
  tsc: 10 * 60_000,
  /** One file in its own invocation. */
  confirm: 10 * 60_000,
} as const;

export const DEFAULT_RADIUS_CAPS = {
  maxWorkspaces: 10,
  maxPaths: 80,
  maxCommits: 40,
  maxTaskCommands: 32,
  maxGuards: 26,
  maxProjectedSec: Math.round((0.9 * SYNC_DELTA_TIMEOUTS_MS.affected) / 1000),
  maxEtaTaskCommands: 96,
  maxEtaGuards: 80,
} satisfies RadiusCaps;

/** A projection is trusted only when history covers at least this share of its tasks. */
export const ETA_MIN_KNOWN_SHARE = 0.75;

/** Single-file re-runs spent CONFIRMING a red before anything is filed. Root
 *  CLAUDE.md: a multi-file vitest invocation can abort during collection, so a
 *  batch verdict must not be attributed to every file it named. */
export const MAX_CONFIRM_RUNS = 3;

/** Radius probes spent ATTRIBUTING a red to an introducing batch. Each is a
 *  `--print-affected` enumeration (no test execution), so this bound is about
 *  wall-clock politeness, not safety. */
export const MAX_ATTRIBUTION_PROBES = 8;

// ── the durable cursor (persisted by the action; shape owned here) ────────────

/** One red this check is currently holding open, so a later run can re-verify it
 *  (refreshing the same conditionKey) instead of re-discovering it from scratch. */
export interface OpenRed {
  /** Repo-relative path of the failing file. */
  path: string;
  /** Workspace the failing file was attributed to, when the runner named one. */
  workspace: string | null;
  /** The batch commit this check attributed it to, or null when unattributed. */
  introducedBy: string | null;
  /** The leg that discovered this red; optional for cursors written before P-037. */
  leg?: 'affected-tests' | 'lint-tsc';
  /** The owner attributed at discovery, carried so retries notify the same holder. */
  assignee?: string | null;
  /** Evidence source for the carried owner attribution. */
  authorSource?: AuthorSource;
  /** Epoch ms this red was first filed. */
  firstSeenMs: number;
  /** How many runs have re-confirmed it (1 = the filing run). */
  confirmations: number;
}

/**
 * The durable state of this check, stored on the routine's OWN row
 * (`harness_shared.routines.metadata.sync_delta`) rather than a new
 * `operator-state-pg` table.
 *
 * WHY THERE and not a new StateTable: each `StateTable` in `operator-state-pg.ts`
 * is its own `harness_shared.<name>` table and therefore its own migration, while
 * `routines.metadata` is the established durable store for exactly this kind of
 * routine-scoped watermark (`gate_health.observedCandidate`, `repair_queue` and
 * `health.dead_target` all live there, each merged through a scoped `jsonb_set`
 * that leaves sibling keys alone). The state is per-routine-row and read by the
 * same routine that writes it, so co-locating it with the row is both cheaper and
 * more discoverable (`routines:list` already surfaces `metadata`).
 */
export interface SyncDeltaCursor {
  /** The last `staging` commit this check processed. */
  sha: string;
  /** Epoch ms of the last run that advanced the cursor. */
  updatedAtMs: number;
  /** Why the last run did no work, when it did none (`host-load`, `radius-too-wide`, …). */
  lastSkipReason?: string;
  /** Epoch ms of that skip. */
  lastSkipMs?: number;
  /** Commits folded into the last processed batch window. */
  lastBatchCommits?: number;
  /** Reds this check is holding open and re-verifying. */
  openReds?: OpenRed[];
  /** Per-tick coverage history + the low-coverage alarm state (P-001 / R-2). */
  coverage?: SyncDeltaCoverage;
  /** Commit cap LEARNED from leg timeouts (green-main-cycle-time-2026-10-08 P-011),
   *  tighter than the static `RadiusCaps.maxCommits`. A leg that exhausts its time
   *  budget halves it, so the next tick judges a smaller window instead of re-running
   *  the identical prefix into the identical timeout (head-of-line blocking: the
   *  cursor sat on one window for 24h, 0 of ~291 ticks evaluated). Each measured run
   *  doubles it; it is dropped once it is back at the static cap. */
  windowCommitCap?: number;
  /** Consecutive undetermined affected runs (non-zero exit, no file named, budget NOT
   *  exhausted) on the window ending at `windowHead` (WI-6554700010017999). Without a
   *  bound, one deterministic unattributable red re-ran the same one-commit window
   *  forever: the cursor sat on a package-lock.json commit for two days, 0 of 291
   *  slots judged. Any other window resets it. */
  undeterminedStreak?: { windowHead: string; count: number };
  /** P-012 (green-main-cycle-time-2026-10-08): the newest commit whose batch check PASSED — both
   *  legs ran green over its window and no red is held open. The gate's fresh cut freezes here
   *  (known-good-freeze.ts) instead of at the bare tip. Carried unchanged by every run that does
   *  not itself pass, so it only ever moves forward to a newer passing commit. */
  lastPassed?: KnownGoodPoint;
}

// ── git-log parsing ──────────────────────────────────────────────────────────

/** One git-sync commit and the paths it touched. */
export interface SyncBatch {
  sha: string;
  /** Commit time, epoch ms (`%ct` * 1000), or null when unparseable. */
  committedAtMs: number | null;
  /** The `Papercusp-Agent:` trailer — the ONLY trustworthy attribution in this repo
   *  (blame and the subject both name the sweeping agent, not the author). */
  agent: string | null;
  /** Repo-relative paths the commit touched. */
  paths: string[];
}

/** The NUL byte git writes for `%x00`, built without a source escape so this file
 *  can never carry a raw control byte (`lint:no-control-bytes` is a
 *  green-checkpoint leg, and one raw byte here reds the fleet gate). */
const NUL = String.fromCharCode(0);

/**
 * Parse `git log <since>..<branch> --first-parent --diff-merges=first-parent --name-only
 *        --format=%x00%H %ct%n%(trailers:key=Papercusp-Agent)`.
 *
 * NUL separates commits; within a block the first line is `<sha> <epoch-seconds>`,
 * an optional `Papercusp-Agent: <id>` trailer follows, and every remaining
 * non-blank line is a changed path. Output order is git's: NEWEST FIRST.
 */
export function parseSyncBatches(raw: string): SyncBatch[] {
  const out: SyncBatch[] = [];
  for (const block of raw.split(NUL)) {
    const lines = block.split('\n').map((l) => l.trim());
    while (lines.length > 0 && lines[0] === '') lines.shift();
    const header = lines.shift();
    if (!header) continue;
    const [sha, ct] = header.split(/\s+/, 2);
    if (!sha || !/^[0-9a-f]{7,64}$/.test(sha)) continue;
    const seconds = Number(ct);
    const paths: string[] = [];
    let agent: string | null = null;
    for (const line of lines) {
      if (!line) continue;
      const trailer = /^Papercusp-Agent:\s*(\S+)/.exec(line);
      if (trailer) {
        agent = trailer[1] ?? null;
        continue;
      }
      paths.push(line);
    }
    out.push({
      sha,
      committedAtMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
      agent,
      paths,
    });
  }
  return out;
}

// ── path-set shaping ─────────────────────────────────────────────────────────

export interface UnionedPaths {
  /** De-duplicated union, in first-seen order across the batch window. */
  paths: string[];
  /** True when the union was cut at `maxPaths` — the caller must treat the run as
   *  a REFUSAL, never as a narrower measurement (a truncated radius under-reports). */
  truncated: boolean;
  /** Union size BEFORE truncation, so a refusal can say how wide it really was. */
  totalPaths: number;
}

/** Union the changed paths of a batch window, capped. Order is stable (first-seen)
 *  so a re-run over the same window produces the same probe argument, which is what
 *  makes the affected-runner's passing-verdict cache able to hit. */
export function unionBatchPaths(batches: readonly SyncBatch[], maxPaths = DEFAULT_RADIUS_CAPS.maxPaths): UnionedPaths {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const b of batches) {
    for (const p of b.paths) {
      if (!p || seen.has(p)) continue;
      seen.add(p);
      paths.push(p);
    }
  }
  const truncated = paths.length > maxPaths;
  return { paths: truncated ? paths.slice(0, maxPaths) : paths, truncated, totalPaths: paths.length };
}

/** The TypeScript files in a path set — what `lint:tsc --files=` is given. A bare
 *  `lint:tsc` typechecks operator-core ONLY, so the `--files` set is the whole
 *  instrument here (root CLAUDE.md). `.d.ts` is excluded: it declares, it never
 *  compiles as a leg's input. */
export function tsFilesOf(paths: readonly string[]): string[] {
  return paths.filter((p) => /\.tsx?$/.test(p) && !p.endsWith('.d.ts'));
}

// ── radius probe parsing + the cap verdict ───────────────────────────────────

export interface RadiusProbe {
  /** `AFFECTED_WS<TAB><name>` lines. */
  workspaces: string[];
  /** `AFFECTED_GUARD<TAB><workspace><TAB><script><TAB><command>` lines, reduced to
   *  `<workspace>:<script>` for cardinality checks. */
  guards: string[];
}

/** One `AFFECTED_WS_CMD<TAB><workspace><TAB><command>` line: the EXACT runnable
 *  invocation for one selected task. Kept as {workspace, command} rather than a
 *  joined string because the command is the whole point — root CLAUDE.md's
 *  standing warning is never to rebuild it from the workspace name (a standalone
 *  submodule needs `npm --prefix`, not `--workspace`, and the `--workspace` form
 *  exits 1 having measured ZERO tests). */
export interface AffectedTaskCommand {
  workspace: string;
  command: string;
}

/** The `AFFECTED_DERIVATION source=… changedPaths=… workspaces=… guards=… tasks=…`
 *  header. `source` is the field that says whether the radius came from an explicit
 *  `--changed-paths` set or from a tree-sized git diff — the distinction that decides
 *  whether a run is verifying YOUR edit or the whole fleet's. */
export interface AffectedDerivation {
  source: string;
  counts: Record<string, number>;
  raw: string;
}

/** `parseAffectedProbe`'s full result. It EXTENDS `RadiusProbe` additively rather
 *  than widening that interface in place: the release lane consumes only
 *  workspaces+guards, so making the new fields required there would strand its
 *  callers and fixtures for data it never reads. Every existing consumer typed as
 *  `RadiusProbe` keeps compiling unchanged. */
export interface AffectedProbe extends RadiusProbe {
  /** Selected TASKS. Note this is a different cardinality from `workspaces`: one
   *  workspace routinely contributes several tasks (operator-core alone splits into
   *  test:lane-pure + test:lane-stateful plus its lint guards), so a workspace count
   *  materially understates what a run will actually execute. */
  taskCommands: AffectedTaskCommand[];
  /** null when the probe emitted no derivation header (older script, or a failed run). */
  derivation: AffectedDerivation | null;
  /** The runner's own projected wall time for this radius (D-030); absent or null when
   *  the probe printed no AFFECTED_ETA line (older script). */
  eta?: AffectedEta | null;
}

/** One `AFFECTED_ETA status=… projectedSec=… …` line. A history-based prognosis, not a
 *  bound: `unknownTasks` says how much of the radius it could not see. */
export interface AffectedEta {
  status: 'projected' | 'unavailable';
  projectedSec: number | null;
  knownTasks: number;
  tasks: number;
  unknownTasks: number;
  heaviestTask: string | null;
  heaviestSec: number | null;
  raw: string;
}

/** Parse one AFFECTED_ETA line; null when the line is not one. */
export function parseAffectedEtaLine(line: string): AffectedEta | null {
  if (!line.startsWith('AFFECTED_ETA ')) return null;
  const fields: Record<string, string> = {};
  for (const field of line.slice('AFFECTED_ETA '.length).trim().split(/\s+/)) {
    const eq = field.indexOf('=');
    if (eq > 0) fields[field.slice(0, eq)] = field.slice(eq + 1);
  }
  const num = (key: string): number | null =>
    fields[key] !== undefined && /^\d+$/.test(fields[key]!) ? Number(fields[key]) : null;
  const projectedSec = num('projectedSec');
  const status = fields.status === 'projected' && projectedSec !== null ? 'projected' : 'unavailable';
  return {
    status,
    projectedSec: status === 'projected' ? projectedSec : null,
    knownTasks: num('knownTasks') ?? 0,
    tasks: num('tasks') ?? 0,
    unknownTasks: num('unknownTasks') ?? 0,
    heaviestTask: fields.heaviestTask ?? null,
    heaviestSec: num('heaviestSec'),
    raw: line.trim(),
  };
}

/** Whether a projection covers enough of the radius to admit by time. */
export function etaIsUsable(eta: AffectedEta | null | undefined): eta is AffectedEta & { projectedSec: number } {
  return (
    !!eta &&
    eta.status === 'projected' &&
    eta.projectedSec !== null &&
    eta.tasks > 0 &&
    eta.knownTasks >= Math.ceil(eta.tasks * ETA_MIN_KNOWN_SHARE)
  );
}

/** Parse `affected-tests.mjs --print-affected` output. It is an ENUMERATION query
 *  that emits no verdict marker, so absence of every line kind means "zero
 *  selected", which is a real (and common) answer. */
export function parseAffectedProbe(stdout: string): AffectedProbe {
  const workspaces: string[] = [];
  const guards: string[] = [];
  const taskCommands: AffectedTaskCommand[] = [];
  let derivation: AffectedDerivation | null = null;
  let eta: AffectedEta | null = null;
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const etaLine = parseAffectedEtaLine(line);
    if (etaLine) {
      eta = etaLine;
      continue;
    }
    // AFFECTED_WS_CMD is tested BEFORE AFFECTED_WS on purpose: `AFFECTED_WS\t(.+)`
    // does not match an `AFFECTED_WS_CMD\t…` line (the literal tab after `AFFECTED_WS`
    // is absent), but relying on that is a one-character-away trap, and mis-ordering
    // it would silently fold task commands into the workspace set — the same corruption
    // green-checkpoint.ts calls out where it parses `AFFECTED_WS\t` into its own Set.
    const cmd = /^AFFECTED_WS_CMD\t([^\t]+)\t(.+)$/.exec(line);
    if (cmd?.[1] && cmd[2]) {
      taskCommands.push({ workspace: cmd[1].trim(), command: cmd[2].trim() });
      continue;
    }
    const ws = /^AFFECTED_WS\t(.+)$/.exec(line);
    if (ws?.[1]) {
      workspaces.push(ws[1].trim());
      continue;
    }
    const guard = /^AFFECTED_GUARD\t([^\t]+)\t([^\t]+)(?:\t.*)?$/.exec(line);
    if (guard?.[1] && guard[2]) {
      guards.push(`${guard[1].trim()}:${guard[2].trim()}`);
      continue;
    }
    if (line.startsWith('AFFECTED_DERIVATION ')) {
      const counts: Record<string, number> = {};
      let source = 'unknown';
      for (const field of line.slice('AFFECTED_DERIVATION '.length).trim().split(/\s+/)) {
        const eq = field.indexOf('=');
        if (eq <= 0) continue;
        const key = field.slice(0, eq);
        const value = field.slice(eq + 1);
        if (key === 'source') {
          source = value;
          continue;
        }
        // Only numeric fields become counts; `runStartHead=<sha>` is deliberately
        // NOT coerced — Number('0a5de631…') is NaN, and a NaN in a counts map reads
        // as a measurement that failed rather than a field that was never a count.
        if (/^\d+$/.test(value)) counts[key] = Number(value);
      }
      derivation = { source, counts, raw: line.trim() };
    }
  }
  return { workspaces, guards, taskCommands, derivation, eta };
}

export type RadiusVerdict =
  | { run: true; workspaces: string[] }
  | { run: false; reason: 'radius-too-wide'; detail: string }
  | { run: false; reason: 'nothing-selected'; detail: string };

/**
 * Should this batch window actually be EXECUTED?
 *
 * `nothing-selected` is a first-class PASS-BY-CONSTRUCTION, not a failure: a batch
 * of docs/plan edits legitimately selects zero task commands and guards, and running
 * the suite for it would be pure waste. A guard-only radius is still runnable even
 * when it names no test workspace. `nothing-selected` is reported separately from `radius-too-wide` because
 * the two want opposite follow-ups (one advances the cursor happily, the other is a
 * measurement we declined to take).
 */
export function evaluateRadius(input: {
  probe: AffectedProbe;
  union: UnionedPaths;
  batchCount: number;
  caps?: RadiusCaps;
}): RadiusVerdict {
  const caps = input.caps ?? DEFAULT_RADIUS_CAPS;
  const maxTaskCommands = caps.maxTaskCommands ?? DEFAULT_RADIUS_CAPS.maxTaskCommands;
  const maxGuards = caps.maxGuards ?? DEFAULT_RADIUS_CAPS.maxGuards;
  const { probe, union, batchCount } = input;
  if (union.truncated) {
    return {
      run: false,
      reason: 'radius-too-wide',
      detail: `${union.totalPaths} changed paths across ${batchCount} commit(s) exceeds maxPaths=${caps.maxPaths}`,
    };
  }
  if (batchCount > caps.maxCommits) {
    return {
      run: false,
      reason: 'radius-too-wide',
      detail: `${batchCount} commits in the window exceeds maxCommits=${caps.maxCommits}`,
    };
  }
  if (probe.workspaces.length > caps.maxWorkspaces) {
    return {
      run: false,
      reason: 'radius-too-wide',
      detail:
        `${probe.workspaces.length} affected workspaces (${probe.workspaces.slice(0, 8).join(', ')}) ` +
        `exceeds maxWorkspaces=${caps.maxWorkspaces}`,
    };
  }
  // D-030: a usable projection replaces the count proxy. The count caps widen to backstops;
  // the projected wall time against the leg budget is what admits or refuses.
  if (etaIsUsable(probe.eta)) {
    const eta = probe.eta;
    const maxProjectedSec = caps.maxProjectedSec ?? DEFAULT_RADIUS_CAPS.maxProjectedSec;
    const maxEtaTasks = caps.maxEtaTaskCommands ?? DEFAULT_RADIUS_CAPS.maxEtaTaskCommands;
    const maxEtaGuards = caps.maxEtaGuards ?? DEFAULT_RADIUS_CAPS.maxEtaGuards;
    const counts =
      `workspaces=${probe.workspaces.length}, tasks=${probe.taskCommands.length}, ` +
      `guards=${probe.guards.length}`;
    if (probe.taskCommands.length > maxEtaTasks || probe.guards.length > maxEtaGuards) {
      return {
        run: false,
        reason: 'radius-too-wide',
        detail: `affected radius has ${counts}; exceeds the projected-time backstops maxEtaTaskCommands=${maxEtaTasks}/maxEtaGuards=${maxEtaGuards}`,
      };
    }
    if (eta.projectedSec > maxProjectedSec) {
      const heaviest =
        eta.heaviestTask !== null ? ` (heaviest ${eta.heaviestTask} ${eta.heaviestSec ?? '?'}s)` : '';
      return {
        run: false,
        reason: 'radius-too-wide',
        detail:
          `affected radius has ${counts}; projected ${eta.projectedSec}s exceeds maxProjectedSec=${maxProjectedSec}s` +
          `${heaviest}; projection from ${eta.knownTasks}/${eta.tasks} tasks with history`,
      };
    }
  } else if (probe.taskCommands.length > maxTaskCommands) {
    return {
      run: false,
      reason: 'radius-too-wide',
      detail:
        `affected radius has workspaces=${probe.workspaces.length}, tasks=${probe.taskCommands.length}, ` +
        `guards=${probe.guards.length}; exceeds maxTaskCommands=${maxTaskCommands}`,
    };
  } else if (probe.guards.length > maxGuards) {
    return {
      run: false,
      reason: 'radius-too-wide',
      detail:
        `affected radius has workspaces=${probe.workspaces.length}, tasks=${probe.taskCommands.length}, ` +
        `guards=${probe.guards.length}; exceeds maxGuards=${maxGuards}`,
    };
  }
  if (probe.taskCommands.length === 0 && probe.guards.length === 0) {
    return {
      run: false,
      reason: 'nothing-selected',
      detail: `${union.paths.length} changed path(s) select no test task or invariant guard`,
    };
  }
  return { run: true, workspaces: probe.workspaces };
}

// ── failure parsing ──────────────────────────────────────────────────────────

/** One failing file as the affected runner itself named it. */
export interface FailingFile {
  workspace: string | null;
  /** Repo-relative when the caller can resolve it; otherwise as reported. */
  file: string;
}

/** SGR colour escapes, so a coloured runner log parses identically to a piped one.
 *  The ESC is built with `String.fromCharCode(27)` rather than a source escape:
 *  `lint:no-control-bytes` is a green-checkpoint leg and one raw ESC byte in source
 *  reds the fleet gate for everybody (EI-19478121013052934). */
const SGR_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/**
 * Parse the runner's canonical break-set line
 * (`AFFECTED_TESTS_FAILING_FILES run=… files=[{workspace,file}] …`).
 *
 * Returns `null` when the line is ABSENT — which is not the same as `[]`. A present
 * line with `files=[]` is the run deliberately saying "red, but I could not name
 * files"; an absent line means the run never reached its terminal verdict at all,
 * and treating that as "no failures" is the false-green this distinction exists to
 * prevent. `sync-batch-delta-check.test.ts` pins this parser against the REAL
 * emitter (`scripts/lib/vitest-summary.mjs`'s `renderFailingFilesSummary`) so the
 * two cannot drift.
 */
export function parseFailingFilesLine(text: string): FailingFile[] | null {
  if (!text) return null;
  let parsed: FailingFile[] | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(SGR_RE, '');
    if (!/^\s*AFFECTED_TESTS_FAILING_FILES\s+run=\S+\s+/.test(line)) continue;
    const filesAt = line.indexOf('files=');
    if (filesAt < 0) continue;
    const unattributedAt = line.indexOf(' unattributed=', filesAt + 'files='.length);
    if (unattributedAt < 0) continue;
    let files: unknown;
    try {
      files = JSON.parse(line.slice(filesAt + 'files='.length, unattributedAt).trim());
    } catch {
      continue;
    }
    if (!Array.isArray(files)) continue;
    const seen = new Set<string>();
    const entries: FailingFile[] = [];
    for (const entry of files) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as { workspace?: unknown; file?: unknown };
      if (typeof rec.file !== 'string' || !rec.file.trim()) continue;
      const workspace = typeof rec.workspace === 'string' && rec.workspace.trim() ? rec.workspace.trim() : null;
      const file = rec.file.trim();
      const key = `${workspace ?? ''} ${file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ workspace, file });
    }
    // The outer runner prints its summary after child output; keep the LAST valid
    // line so a nested fixture invocation cannot mask the run-level break set.
    parsed = entries;
  }
  return parsed;
}

/** Extract the distinct files named by `error TS…` diagnostics. `tsc` prints
 *  `path/to/file.ts(12,3): error TS2339: …`; a leg that compiled nothing prints
 *  none, which is why the caller must ALSO read the leg's exit code rather than
 *  inferring green from an empty list. */
export function parseTscFailingFiles(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(SGR_RE, '');
    const m = /^\s*(\S+?\.[cm]?tsx?)\((\d+),(\d+)\):\s+error TS\d+/.exec(line);
    const file = m?.[1];
    if (!file || seen.has(file)) continue;
    seen.add(file);
    out.push(file);
  }
  return out;
}

// ── host-load gate ───────────────────────────────────────────────────────────

export interface LoadReading {
  /** 1-minute load average. */
  load1: number;
  /** Online CPUs. */
  cores: number;
}

/** Parse `/proc/loadavg`'s first field. Returns null when the file is not the shape
 *  we expect — an unreadable instrument must never render as "load is fine". */
export function parseLoadavg1(raw: string): number | null {
  const first = raw.trim().split(/\s+/)[0];
  const n = Number(first);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The budget one tick may spend confirming and attributing reds. */
export interface CheckBudget {
  maxConfirmRuns: number;
  maxAttributionProbes: number;
}

/**
 * What a tick may do given host load and the gate.
 *
 * P-001 (gate-throughput-shift-left-2026-10-06): the old rule SKIPPED above
 * `cores * LOAD_SKIP_FACTOR` and whenever a green-checkpoint suite ran. On this box
 * load sits above that line for most of the day and the gate runs for hours, so the
 * check judged almost nothing — exactly the per-commit signal it exists to provide.
 * green-main-ratchet-convergence-2026-10-17 P-009 (D-017): load NEVER skips. Every heavy
 * leg runs in its own reserved slice (`reservedCapacityArgv`), so its share of the box is
 * fixed by the slice weight, not by how busy everyone else is. Load and the gate only
 * shrink the confirm/attribution budget. The radius caps are NOT reduced, so no batch
 * window is dropped as too wide because of load.
 *
 * The two cases that used to skip — load above the hard ceiling and an UNREADABLE load —
 * now run with the reduced budget and say why. The 24h measurement before this change
 * found the lint guards skipping at load 384.91 > 384, i.e. judging nothing exactly when
 * the fleet was busiest and commits were densest.
 */
export interface CapacityVerdict {
  mode: 'full' | 'reduced';
  reason?: string;
  budget: CheckBudget;
}

export function evaluateCapacity(input: {
  reading: LoadReading | null;
  /** true / false / null (undetectable). Only `true` reduces the budget. */
  gateRunning: boolean | null;
  fullBudget: CheckBudget;
  softFactor?: number;
  hardFactor?: number;
}): CapacityVerdict {
  const soft = input.softFactor ?? LOAD_SKIP_FACTOR;
  const hard = input.hardFactor ?? HARD_LOAD_CEILING_FACTOR;
  const { reading } = input;
  const reasons: string[] = [];
  if (!reading || !Number.isFinite(reading.load1) || !(reading.cores > 0)) {
    reasons.push('host-load-unreadable');
  } else {
    const hardCeiling = reading.cores * hard;
    const softCeiling = reading.cores * soft;
    if (reading.load1 > hardCeiling) {
      reasons.push(
        `host-load ${reading.load1.toFixed(2)} > hard ceiling ${hardCeiling.toFixed(2)} (cores ${reading.cores} x ${hard})`,
      );
    } else if (reading.load1 > softCeiling) {
      reasons.push(`host-load ${reading.load1.toFixed(2)} > ${softCeiling.toFixed(2)}`);
    }
  }
  if (input.gateRunning === true) reasons.push('green-checkpoint-running');
  if (reasons.length === 0) return { mode: 'full', budget: input.fullBudget };
  return {
    mode: 'reduced',
    reason: reasons.join('; '),
    budget: {
      maxConfirmRuns: Math.min(input.fullBudget.maxConfirmRuns, REDUCED_BUDGET.maxConfirmRuns),
      maxAttributionProbes: Math.min(input.fullBudget.maxAttributionProbes, REDUCED_BUDGET.maxAttributionProbes),
    },
  };
}

/** The user-manager slice the heavy legs run in (D-017 point 2). Deliberately NOT named
 *  `papercusp-*`: a dash nests a slice under its prefix, and `papercusp.slice` carries
 *  CPUWeight=25, which is why nothing launched by the task manager can be reserved. A
 *  top-level slice sits beside app.slice; weight 100 is systemd's default, so the checks
 *  get an equal share with app.slice and can never starve the gate. */
export const SOURCE_CHECK_SLICE = 'source-checks.slice';
export const SOURCE_CHECK_CPU_WEIGHT = 100;
export const SOURCE_CHECK_IO_WEIGHT = 100;

/** Wrap a heavy leg so it runs in the reserved `source-checks.slice` (P-009 / D-017).
 *  `systemd-run --scope` execs the payload itself, so cwd, environment, stdio and the
 *  caller's timeout signal all reach the payload unchanged. When the scope cannot launch
 *  (no user bus, no systemd-run), the binding retries the payload unwrapped and records
 *  that in its diagnostic: `isScopeLaunchFailure`. */
export function reservedCapacityArgv(cmd: string, args: readonly string[]): { cmd: string; args: string[] } {
  return {
    cmd: 'systemd-run',
    args: [
      '--user',
      '--scope',
      '--quiet',
      ...SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS,
      `--slice=${SOURCE_CHECK_SLICE}`,
      `--property=CPUWeight=${SOURCE_CHECK_CPU_WEIGHT}`,
      `--property=IOWeight=${SOURCE_CHECK_IO_WEIGHT}`,
      '--',
      cmd,
      ...args,
    ],
  };
}

/** A scope that failed to START exits non-zero within seconds with a systemd-run error on
 *  stderr. A payload that fails inside a healthy scope exits with its own code, usually
 *  long after the launch window, so it never matches (the release-actions precedent). */
export const SCOPE_LAUNCH_WINDOW_MS = 5_000;

export function isScopeLaunchFailure(r: {
  status: number | null;
  stderr: string;
  durationMs?: number;
  failureKind?: string;
}): boolean {
  if (r.failureKind) return false;
  if (r.status === 0 || r.status === null) return false;
  if (r.durationMs !== undefined && r.durationMs >= SCOPE_LAUNCH_WINDOW_MS) return false;
  return SCOPE_LAUNCH_FAILURE_RE.test(r.stderr);
}

// ── coverage (P-001 / R-2) ───────────────────────────────────────────────────

/** One scheduled coverage opportunity. `measured` and `partial` come from the lint-guard
 *  routine (`sync-batch-lint-guards.ts`), which records its slots with this same machinery:
 *  `partial` = some guards gave no verdict, so their window is still unjudged. */
export type CoverageTickStatus = SyncBatchDeltaStatus | 'missed-opportunity' | 'measured' | 'partial';

export interface CoverageTick {
  atMs: number;
  /** true = the scheduled opportunity judged its window (or confirmed nothing to judge),
   *  or a later run judged this slot's commits within COVERAGE_JUDGE_DEADLINE_MS. */
  evaluated: boolean;
  status: CoverageTickStatus;
  /** Bounded reason/outcome for a non-evaluated tick. */
  reason?: string;
  /** Set when a LATER run judged this slot's commits (P-009 / D-017 point 3): the epoch ms
   *  that run finished. The slot keeps its original status, so late judgments stay visible. */
  judgedAtMs?: number;
}

export interface SyncDeltaCoverage {
  ticks: CoverageTick[];
  /** Epoch ms the low-coverage alarm was raised; absent while coverage is healthy. */
  alarmOpenSinceMs?: number;
  /** Epoch ms the open alarm was last (re-)filed with current numbers; absent on cursors
   *  written before WI-6554700010018239, which then refresh on their next low tick. */
  alarmRefreshedAtMs?: number;
}

/** Coverage history kept on the cursor: 24h, bounded so the row cannot grow. */
export const COVERAGE_RETENTION_MS = 24 * 60 * 60_000;
export const COVERAGE_MAX_TICKS = 400;
/** The durable sync-delta routine fires every five minutes. Coverage fills
 *  opportunities that passed while an earlier invocation was still running. */
export const COVERAGE_EXPECTED_INTERVAL_MS = 5 * 60_000;
/** The alarm window, threshold and the minimum opportunities needed to judge it
 *  (green-main-ratchet-convergence-2026-10-17 P-009 / D-017 point 4: at least 95% of
 *  schedule slots over 24 hours). At the five-minute cadence 24h is 288 slots; 144 is
 *  twelve hours of history, so a fresh history cannot alarm on a handful of samples. */
export const COVERAGE_ALARM_WINDOW_MS = 24 * 60 * 60_000;
export const COVERAGE_ALARM_THRESHOLD = 0.95;
export const COVERAGE_ALARM_MIN_TICKS = 144;
/** One delta-check run's worst in-budget wall: probe, then tsc, then affected, in series
 *  (runSyncBatchDeltaCheck), each killed at its SYNC_DELTA_TIMEOUTS_MS budget. The red-confirm
 *  leg is excluded: it runs only after a red was found, and the 95% target absorbs those slots
 *  (green-main-ratchet-convergence-2026-10-17#D-031 point 3). */
export const SYNC_DELTA_RUN_BUDGET_MS =
  SYNC_DELTA_TIMEOUTS_MS.probe + SYNC_DELTA_TIMEOUTS_MS.tsc + SYNC_DELTA_TIMEOUTS_MS.affected;
/** A slot whose own run did not judge it still counts as evaluated when a later run
 *  judged its commits within this long (D-017 point 3). One completed run per slot caps
 *  coverage at runs/slots whenever a single affected-tests run outlasts five minutes
 *  (measured 104/291 = 36% before P-009), although those commits were judged minutes
 *  later. Slots judged later than this, or never, stay not evaluated.
 *
 *  DERIVED, not chosen (D-031, refining D-030 #3): runs go one at a time, so a slot that
 *  arrives mid-run is judged by the NEXT run, which starts within one run plus one interval
 *  and ends one run later. A check that is keeping up therefore judges every slot within
 *  2 x SYNC_DELTA_RUN_BUDGET_MS + COVERAGE_EXPECTED_INTERVAL_MS (135 min today: legs
 *  10 + 10 + 45 per D-034, so 2 x 65 + 5); the old fixed
 *  30 minutes assumed a few-minute run and failed normal in-budget runs by construction. */
export const COVERAGE_JUDGE_DEADLINE_MS = 2 * SYNC_DELTA_RUN_BUDGET_MS + COVERAGE_EXPECTED_INTERVAL_MS;

/** Non-evaluated statuses whose commits a later run can still judge. `skipped` and
 *  `missed-opportunity` leave the cursor where it was; a lint-guard `partial` keeps each
 *  unmeasured guard's older record, so the next tick re-measures it. `leg-timeout` and
 *  `radius-too-wide` advance the cursor PAST commits nobody judged, so they are never
 *  credited. */
const LATE_CREDITABLE_STATUSES: ReadonlySet<CoverageTickStatus> = new Set(['skipped', 'missed-opportunity', 'partial']);

/**
 * Credit earlier slots whose commits an evaluated run judged within the deadline.
 * `throughMs`: every commit at or before this time was judged (the run's start when it
 * judged the whole backlog, else its newest judged commit's time). `judgedAtMs`: when
 * that run finished. Pure; returns the input unchanged when nothing qualifies.
 */
export function creditLateJudgedSlots<T extends { ticks: CoverageTick[] }>(
  coverage: T,
  judged: { throughMs: number; judgedAtMs: number; deadlineMs?: number },
): T {
  const deadlineMs = judged.deadlineMs ?? COVERAGE_JUDGE_DEADLINE_MS;
  if (!Number.isFinite(judged.throughMs) || !Number.isFinite(judged.judgedAtMs)) return coverage;
  let changed = false;
  const ticks = coverage.ticks.map((t) => {
    if (
      t.evaluated ||
      !LATE_CREDITABLE_STATUSES.has(t.status) ||
      t.atMs > judged.throughMs ||
      t.atMs > judged.judgedAtMs ||
      judged.judgedAtMs - t.atMs > deadlineMs
    ) {
      return t;
    }
    changed = true;
    return { ...t, evaluated: true, judgedAtMs: judged.judgedAtMs };
  });
  return changed ? { ...coverage, ticks } : coverage;
}

/** Statuses that mean the window WAS judged. `radius-too-wide` advances the cursor
 *  without running anything, so it counts as NOT evaluated, the same as a skip. */
const EVALUATED_STATUSES: ReadonlySet<SyncBatchDeltaStatus> = new Set([
  'bootstrapped',
  'up-to-date',
  'nothing-selected',
  'green',
  'red',
]);

export function isEvaluatedStatus(status: SyncBatchDeltaStatus): boolean {
  return EVALUATED_STATUSES.has(status);
}

export function recordCoverageTick(
  prior: SyncDeltaCoverage | undefined,
  tick: CoverageTick,
): SyncDeltaCoverage {
  const cutoff = tick.atMs - COVERAGE_RETENTION_MS;
  const ticks = [...(prior?.ticks ?? []).filter((t) => t.atMs >= cutoff), tick].slice(-COVERAGE_MAX_TICKS);
  return {
    ...(prior?.alarmOpenSinceMs !== undefined ? { alarmOpenSinceMs: prior.alarmOpenSinceMs } : {}),
    ...(prior?.alarmRefreshedAtMs !== undefined ? { alarmRefreshedAtMs: prior.alarmRefreshedAtMs } : {}),
    ticks,
  };
}

/** Record a completed invocation plus schedule opportunities that passed while
 *  there was no completed invocation to judge them. `tick.atMs` is captured at
 *  action start; `observedUntilMs` is captured after it finishes. Routine-fire
 *  deduplication suppresses cron starts while a previous action is still running,
 *  so counting completions alone makes a long action erase those missed slots
 *  from this detector's denominator.
 */
export function recordCoverageOpportunities(
  prior: SyncDeltaCoverage | undefined,
  tick: CoverageTick,
  observedUntilMs: number,
  intervalMs: number = COVERAGE_EXPECTED_INTERVAL_MS,
): SyncDeltaCoverage {
  const priorTicks = prior?.ticks ?? [];
  const lastAtMs = priorTicks.at(-1)?.atMs;
  if (
    lastAtMs === undefined ||
    !Number.isFinite(tick.atMs) ||
    !Number.isFinite(observedUntilMs) ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0 ||
    tick.atMs <= lastAtMs ||
    observedUntilMs < tick.atMs
  ) {
    return recordCoverageTick(prior, tick);
  }

  const cutoff = observedUntilMs - COVERAGE_RETENTION_MS;
  const missedBetweenInvocations = Math.max(0, Math.round((tick.atMs - lastAtMs) / intervalMs) - 1);
  const missedDuringInvocation = Math.max(0, Math.ceil((observedUntilMs - tick.atMs) / intervalMs) - 1);
  const missed: CoverageTick[] = [];
  const appendMissed = (originMs: number, count: number): void => {
    const firstIndex = Math.max(
      1,
      count - COVERAGE_MAX_TICKS + 1,
      Math.ceil((cutoff - originMs) / intervalMs),
    );
    for (let index = firstIndex; index <= count; index += 1) {
      const atMs = originMs + index * intervalMs;
      if (atMs >= cutoff && atMs < observedUntilMs) {
        missed.push({ atMs, evaluated: false, status: 'missed-opportunity' });
      }
    }
  };
  appendMissed(lastAtMs, missedBetweenInvocations);
  appendMissed(tick.atMs, missedDuringInvocation);

  const base = prior ?? { ticks: [] };
  return [...missed, tick]
    .sort((a, b) => a.atMs - b.atMs)
    .reduce((coverage, next) => recordCoverageTick(coverage, next), base);
}

export interface CoverageVerdict {
  /** Ticks inside the window. */
  total: number;
  evaluated: number;
  /** Of `evaluated`, slots credited because a later run judged them within the deadline. */
  lateCredited: number;
  /** evaluated / total, or null when there are too few ticks to judge. */
  ratio: number | null;
  /** true = coverage is below the threshold on enough samples. */
  low: boolean;
}

export function evaluateCoverage(
  coverage: { ticks: CoverageTick[] } | undefined,
  nowMs: number,
  opts?: { windowMs?: number; threshold?: number; minTicks?: number },
): CoverageVerdict {
  const windowMs = opts?.windowMs ?? COVERAGE_ALARM_WINDOW_MS;
  const threshold = opts?.threshold ?? COVERAGE_ALARM_THRESHOLD;
  const minTicks = opts?.minTicks ?? COVERAGE_ALARM_MIN_TICKS;
  const inWindow = (coverage?.ticks ?? []).filter((t) => t.atMs > nowMs - windowMs && t.atMs <= nowMs);
  const evaluated = inWindow.filter((t) => t.evaluated).length;
  const lateCredited = inWindow.filter((t) => t.evaluated && t.judgedAtMs !== undefined).length;
  if (inWindow.length < minTicks) return { total: inWindow.length, evaluated, lateCredited, ratio: null, low: false };
  const ratio = evaluated / inWindow.length;
  return { total: inWindow.length, evaluated, lateCredited, ratio, low: ratio < threshold };
}

/** The coverage alarm's upsert identity — one open item, refreshed in place. */
export const COVERAGE_ALARM_CONDITION_KEY = 'sync-delta-coverage-low';

/** Which check an alarm is about. Defaults describe the delta check; the lint-guard
 *  routine passes its own (P-009 / D-017 point 4). */
export interface CoverageAlarmSubject {
  conditionKey: string;
  /** Human name, e.g. "sync-batch delta check". */
  label: string;
  filedBy: string;
  /** Where to read the coverage history. */
  stateHint: string;
  path: string;
  /** This check's slot-credit deadline (the `deadlineMs` it passes to creditLateJudgedSlots),
   *  so the alarm states the window the check is actually judged against (D-031). */
  judgeDeadlineMs: number;
}

export const DELTA_COVERAGE_ALARM_SUBJECT: CoverageAlarmSubject = {
  conditionKey: COVERAGE_ALARM_CONDITION_KEY,
  label: 'sync-batch delta check',
  judgeDeadlineMs: COVERAGE_JUDGE_DEADLINE_MS,
  filedBy: 'system:sync-batch-delta-check',
  stateHint:
    'Read metadata.sync_delta with a workspace-scoped dev:pg_query; routines:list does not return it ' +
    '(lastSkipReason and coverage.ticks[].reason carry bounded skip diagnostics).',
  path: 'packages/operator-core/lib/release/sync-batch-delta-check.ts',
};

function formatWindow(ms: number): string {
  const hours = ms / (60 * 60_000);
  return Number.isInteger(hours) ? `${hours}h` : `${Math.round(ms / 60_000)}m`;
}

export function buildCoverageAlarm(
  verdict: CoverageVerdict,
  coverage: { ticks: CoverageTick[] },
  subject: CoverageAlarmSubject = DELTA_COVERAGE_ALARM_SUBJECT,
): RedFinding {
  const pct = verdict.ratio === null ? 'n/a' : `${Math.round(verdict.ratio * 100)}%`;
  const windowLabel = formatWindow(COVERAGE_ALARM_WINDOW_MS);
  const reasons = new Map<string, number>();
  for (const t of coverage.ticks.slice(-verdict.total)) {
    if (!t.evaluated) {
      const label = t.reason ? `${t.status} (${t.reason})` : t.status;
      reasons.set(label, (reasons.get(label) ?? 0) + 1);
    }
  }
  const breakdown = [...reasons.entries()].map(([s, n]) => `${s} x${n}`).join(', ') || '(none)';
  const deadline = formatWindow(subject.judgeDeadlineMs);
  return {
    conditionKey: subject.conditionKey,
    title: `${subject.label} coverage low: ${pct} of schedule slots judged over ${windowLabel}`,
    body: [
      `The ${subject.label} judged only ${verdict.evaluated} of ${verdict.total} schedule slots (${pct}) in the last ${windowLabel},`,
      `below the ${Math.round(COVERAGE_ALARM_THRESHOLD * 100)}% target. A slot counts when its own run judged it, or when a`,
      `later run judged its commits within ${deadline} (${verdict.lateCredited} of the judged slots were credited that way).`,
      'Breakage committed to staging in the unjudged slots is NOT being caught at commit time; it will surface at the gate instead.',
      '',
      `Unjudged slots by status: ${breakdown}.`,
      subject.stateHint,
      '`radius-too-wide` means batches exceed the radius caps; `leg-timeout` means a single commit exhausted a leg',
      'time budget and was explicitly skipped (both advance past commits nobody judged).',
      `\`missed-opportunity\` means a five-minute slot passed without a completed check and no later check judged it within ${deadline}.`,
      'Load no longer skips this check (green-main-ratchet-convergence-2026-10-17#D-017): it runs in the reserved source-checks slice.',
      '',
      `Filed by \`${subject.filedBy}\` (conditionKey \`${subject.conditionKey}\`).`,
    ].join('\n'),
    paths: [subject.path],
    assignee: null,
    authorSource: 'none',
  };
}

/** How often an OPEN low-coverage alarm is re-filed so its numbers stay current
 *  (WI-6554700010018239). Without it the item kept the text of the tick that opened it:
 *  the 2026-10-07 alarm still read "2h window, 80% floor" thirteen days and one rule
 *  change later. A re-file goes through the conditionKey upsert, which rewrites an
 *  UNCLAIMED incumbent's title/summary and leaves a claimed one's subject alone; if the
 *  item was closed meanwhile, the same re-file mints a fresh alarm. */
export const COVERAGE_ALARM_REFRESH_MS = 60 * 60_000;

/**
 * Raise, refresh or clear the low-coverage alarm for one check. Both sync-batch checks
 * call this so their alarm lifecycles cannot drift apart (P-009 / D-017 point 4).
 * - low, no alarm open → file it; on success record open + refreshed times.
 * - low, alarm open, last (re-)file at least `COVERAGE_ALARM_REFRESH_MS` ago → re-file
 *   with the current verdict; on success record the refresh time. A cursor written
 *   before refresh existed has only `alarmOpenSinceMs`, which stands in as the last file.
 * - healthy on enough samples, alarm open → clear both times (the item itself is left
 *   to its holder or the condition reconciler).
 * Filing failures never throw and never advance the timestamps, so the next tick retries.
 */
export async function maintainCoverageAlarm(
  deps: Pick<SyncBatchDeltaDeps, 'fileRed' | 'log'>,
  coverage: SyncDeltaCoverage,
  verdict: CoverageVerdict,
  now: number,
  opts: { subject?: CoverageAlarmSubject; logLabel: string },
): Promise<SyncDeltaCoverage> {
  if (verdict.low) {
    const lastFiledMs = coverage.alarmRefreshedAtMs ?? coverage.alarmOpenSinceMs;
    const opening = coverage.alarmOpenSinceMs === undefined;
    if (!opening && lastFiledMs !== undefined && now - lastFiledMs < COVERAGE_ALARM_REFRESH_MS) return coverage;
    const res = await deps.fileRed(buildCoverageAlarm(verdict, coverage, opts.subject));
    deps.log(
      `[${opts.logLabel}] coverage low (${verdict.evaluated}/${verdict.total}) — alarm ` +
        `${res.ok ? (opening ? 'filed' : 'refreshed') : `${opening ? 'filing' : 'refresh'} failed: ${res.error}`}`,
    );
    if (!res.ok) return coverage;
    return opening
      ? { ...coverage, alarmOpenSinceMs: now, alarmRefreshedAtMs: now }
      : { ...coverage, alarmRefreshedAtMs: now };
  }
  if (verdict.ratio !== null && coverage.alarmOpenSinceMs !== undefined) {
    const { alarmOpenSinceMs: _open, alarmRefreshedAtMs: _refreshed, ...rest } = coverage;
    return rest;
  }
  return coverage;
}

// ── author routing (P-002 / R-3) ─────────────────────────────────────────────

/** One edit-ledger row: the newest recorded editor of a file. */
export interface EditorHit {
  file: string;
  agent: string;
  tsMs: number;
}

export type AuthorSource = 'edit-ledger:failing-file' | 'edit-ledger:batch' | 'trailer' | 'none';

/**
 * Who should be told about a confirmed red. Never `git blame`, never the commit
 * subject — git-sync sweeps the whole tree under one identity (root CLAUDE.md).
 *
 * Order, strongest evidence first:
 *   1. the newest ledgered editor of the FAILING FILE itself;
 *   2. the newest ledgered editor of any path in the attributed batch;
 *   3. the batch's `Papercusp-Agent` trailer;
 *   4. nobody — the item files unassigned and says so.
 *
 * Only `system:` identities are excluded (a routine is not a person to route to).
 */
export function pickRedAuthor(input: {
  failingFile: string;
  batch: SyncBatch | null;
  editors: readonly EditorHit[] | null;
}): { agent: string | null; source: AuthorSource } {
  const editors = (input.editors ?? []).filter((e) => e.agent && !e.agent.startsWith('system:'));
  const newest = (hits: EditorHit[]): EditorHit | undefined => [...hits].sort((a, b) => b.tsMs - a.tsMs)[0];
  const onFile = newest(editors.filter((e) => e.file === input.failingFile));
  if (onFile) return { agent: onFile.agent, source: 'edit-ledger:failing-file' };
  if (input.batch) {
    const batchPaths = new Set(input.batch.paths);
    const onBatch = newest(editors.filter((e) => batchPaths.has(e.file)));
    if (onBatch) return { agent: onBatch.agent, source: 'edit-ledger:batch' };
    if (input.batch.agent && !input.batch.agent.startsWith('system:')) {
      return { agent: input.batch.agent, source: 'trailer' };
    }
  }
  return { agent: null, source: 'none' };
}

// ── batch attribution ────────────────────────────────────────────────────────

export interface Attribution {
  /** The batch this red is attributed to, or null when none could be named. */
  batch: SyncBatch | null;
  /** How it was decided — evidence, not a label. */
  how: 'exact-path' | 'radius' | 'unattributed';
  /** Radius probes spent (so the caller can keep the total under the cap). */
  probesUsed: number;
}

/**
 * Walk the window NEWEST→OLDEST and name the first batch that could have introduced
 * `failing`.
 *
 * Two tiers, cheapest first:
 *   1. EXACT — the batch touched the failing file itself.
 *   2. RADIUS — the batch's own changed paths select the workspace the failing file
 *      belongs to (one `--print-affected` enumeration per batch, capped).
 *
 * ⚠ This is a RADIUS argument, not a bisect: a true bisect would have to check out
 * each candidate sha, and this runs on the SHARED tree where no checkout is
 * permissible (root CLAUDE.md forbids every tree-wide destructive git op, and the
 * whole fleet is editing that tree concurrently). So the verdict names the newest
 * batch that *can reach* the break — the honest claim the evidence supports — and
 * `how` says which tier produced it so a reader never mistakes a radius hit for a
 * proven culprit.
 */
export async function attributeIntroducingBatch(input: {
  batches: readonly SyncBatch[];
  failing: FailingFile;
  /** Enumerate the affected workspaces for one batch's paths. Return null when the
   *  probe itself failed — an unmeasurable batch is skipped, never assumed clean. */
  probeBatch: (paths: readonly string[]) => Promise<RadiusProbe | null>;
  maxProbes?: number;
}): Promise<Attribution> {
  const maxProbes = input.maxProbes ?? MAX_ATTRIBUTION_PROBES;
  let probesUsed = 0;
  for (const batch of input.batches) {
    if (batch.paths.includes(input.failing.file)) {
      return { batch, how: 'exact-path', probesUsed };
    }
  }
  if (!input.failing.workspace) return { batch: null, how: 'unattributed', probesUsed };
  for (const batch of input.batches) {
    if (probesUsed >= maxProbes) break;
    if (batch.paths.length === 0) continue;
    probesUsed += 1;
    const probe = await input.probeBatch(batch.paths);
    if (!probe) continue;
    if (probe.workspaces.includes(input.failing.workspace)) {
      return { batch, how: 'radius', probesUsed };
    }
  }
  return { batch: null, how: 'unattributed', probesUsed };
}

// ── the filed finding ────────────────────────────────────────────────────────

/** The upsert identity: ONE open item per failing file, refreshed rather than
 *  re-filed. `work_items:create`'s `conditionKey` adopts an OPEN incumbent holding
 *  this key, which is what keeps a 5-minute cadence from becoming a spam engine. */
export function conditionKeyForRed(filePath: string): string {
  return `sync-delta-red:${filePath}`;
}

export interface RedFinding {
  conditionKey: string;
  title: string;
  body: string;
  /** Paths the item is about — the failing file plus the introducing batch's paths. */
  paths: string[];
  /** The agent the item is assigned to (P-002), or null to file it unassigned. */
  assignee: string | null;
  /** Where `assignee` came from — evidence, carried into the body. */
  authorSource: AuthorSource;
}

/** Render the work-item a confirmed red becomes. Every field a triager needs is in
 *  the BODY, because a work-item body is what survives; a routine's console log does
 *  not. */
export function buildRedFinding(input: {
  failing: FailingFile;
  attribution: Attribution;
  /** The whole window this run judged, newest first. */
  batches: readonly SyncBatch[];
  leg: 'affected-tests' | 'lint-tsc';
  slaMinutes?: number;
  /** Prior open-red record, when this is a REFRESH rather than a first filing. */
  prior?: OpenRed | null;
  /** Who the item is routed to (P-002); absent ⇒ unassigned. */
  author?: { agent: string | null; source: AuthorSource };
}): RedFinding {
  const author = input.author ?? { agent: null, source: 'none' as const };
  const sla = input.slaMinutes ?? SYNC_DELTA_SLA_MINUTES;
  const { failing, attribution, batches, leg } = input;
  const batch = attribution.batch;
  const legLabel = leg === 'lint-tsc' ? 'lint:tsc' : 'test:affected';
  const title = `sync-batch delta red: ${failing.file} (${legLabel})`;

  const oldest = batches[batches.length - 1];
  const newest = batches[0];
  const windowLine =
    !oldest || !newest
      ? 'Window: (re-verification of an already-open red; no new commits judged this tick)'
      : `Window: ${batches.length} commit(s), ${oldest.sha.slice(0, 12)}..${newest.sha.slice(0, 12)}`;

  const attributionBlock = batch
    ? [
        `Introducing batch: ${batch.sha}`,
        `  attributed by: ${
          attribution.how === 'exact-path'
            ? 'the batch touched this exact file'
            : "the batch's changed paths select this file's workspace"
        }`,
        `  Papercusp-Agent trailer: ${batch.agent ?? '(none)'}`,
        `  changed paths (${batch.paths.length}): ${batch.paths.slice(0, 25).join(', ')}${
          batch.paths.length > 25 ? ', ...' : ''
        }`,
      ].join('\n')
    : [
        'Introducing batch: NOT ATTRIBUTED.',
        `  No commit in the window touches this file, and no batch's radius selects ${
          failing.workspace ?? 'its workspace'
        }.`,
        '  Treat the whole window as the suspect set; do NOT read this as "nobody did it".',
      ].join('\n');

  const lines = [
    `\`${failing.file}\` is RED on \`staging\` and the break falls inside a recent git-sync batch.`,
    '',
    `Failing file: ${failing.file}`,
    `Workspace:    ${failing.workspace ?? '(not named by the runner)'}`,
    `Detected by:  ${legLabel}, re-confirmed in its own single-file invocation`,
    windowLine,
    '',
    attributionBlock,
    '',
    author.agent
      ? `Routed to: ${author.agent} (source: ${author.source}). The commit was NOT reverted or held — this is an alert.`
      : 'Routed to: nobody — no ledgered editor or Papercusp-Agent trailer was found for this break. Claim it if it is yours.',
    '',
    `SLA: fix or revert within ${sla} minutes.`,
    'Past that the hourly green-checkpoint freezes a candidate on top of this break, and every later',
    'red inherits its attribution — which is the failure this check exists to prevent.',
    '',
    'Repair, in order:',
    `  1. \`npm run test:file -- ${failing.file}\` (or \`npm run lint:tsc -- --files=${failing.file}\`) to see the break.`,
    "  2. Fix forward if it is small. If it is not, revert the introducing batch's change to the paths above.",
    '  3. Re-run the same command to prove it green.',
    '',
    'Attribution caveat: this is a RADIUS argument, not a bisect. The shared tree cannot be checked out',
    'per-candidate, so the named batch is the NEWEST one whose changed paths can reach this file — strong',
    'evidence, not proof. `git blame` and the commit subject are worthless here (git-sync sweeps the whole',
    'tree under one identity); the `Papercusp-Agent` trailer above is the only trustworthy attribution.',
    '',
    `Filed by \`system:sync-batch-delta-check\` (conditionKey \`${conditionKeyForRed(
      failing.file,
    )}\` — this item is refreshed in place while the red persists, never re-filed as a sibling).`,
  ];
  if (input.prior) {
    lines.push(
      `Re-confirmed ${input.prior.confirmations + 1}x since ${new Date(input.prior.firstSeenMs).toISOString()}.`,
    );
  }

  const paths = [failing.file, ...(batch?.paths ?? [])].filter((p, i, a) => a.indexOf(p) === i).slice(0, 40);
  return {
    conditionKey: conditionKeyForRed(failing.file),
    title,
    body: lines.join('\n'),
    paths,
    assignee: author.agent,
    authorSource: author.source,
  };
}

// ── the orchestration (deps-injected, so it is unit-testable end to end) ─────

/** Verdict of one single-file re-run. `null` = the run could not be measured
 *  (`matched=0`, a route error, no terminal line) — deliberately distinct from
 *  `false`, because "undetermined" must never be filed as a red. */
export type ConfirmVerdict = boolean | null;

export interface SubprocessDiagnostic {
  outcome: 'completed' | 'timeout' | 'output-buffer-limit' | 'spawn-error' | 'nonzero-exit';
  durationMs: number | null;
  exitCode: number | null;
}

export interface SyncBatchDeltaDeps {
  /** Read the durable cursor, or null when this check has never run here. */
  readCursor(): Promise<SyncDeltaCursor | null>;
  /** Persist the cursor (merged under `routines.metadata.sync_delta`). */
  writeCursor(next: SyncDeltaCursor): Promise<void>;
  /** `/proc/loadavg` + core count, or null when unreadable. */
  hostLoad(): LoadReading | null;
  // ⛔ Every leg below shells out, and therefore returns a Promise BY CONTRACT
  // (WI-10001771). The binding runs inside bg-host, which serves :3271 and the DBOS
  // routine engine on the same event loop, so a synchronous implementation
  // (`spawnSync`/`execFileSync`) blocks that loop for the child's whole lifetime and
  // takes the routine engine down fleet-wide. Keep these async even if a future
  // binding's work looks instant.
  /** true = a green-checkpoint suite is running; false = it is not; null = undetectable. */
  greenCheckpointRunning(): Promise<boolean | null>;
  /** Tip of the integration branch, or null when git could not be read. */
  headSha(): Promise<string | null>;
  /** Commits in `(sinceSha, HEAD]`, newest first; null when git could not be read. */
  listBatches(sinceSha: string): Promise<SyncBatch[] | null>;
  /** `affected-tests.mjs --print-affected` for a path set; null when the probe failed. */
  probeRadius(paths: readonly string[]): Promise<AffectedProbe | null>;
  /** `affected-tests.mjs --changed-paths <paths>` — the actual run. `failing: null`
   *  on a red means the run named no files, i.e. UNDETERMINED. */
  runAffected(paths: readonly string[]): Promise<{
    ok: boolean;
    failing: FailingFile[] | null;
    diagnostic?: SubprocessDiagnostic;
  }>;
  /** `lint-tsc.mjs --files=<files>`. */
  runTsc(files: readonly string[]): Promise<{
    ok: boolean;
    failing: string[];
    diagnostic?: SubprocessDiagnostic;
  }>;
  /** One file, in its OWN invocation (root CLAUDE.md's gate-triage rule).
   *  `true` = passed, `false` = failed, `null` = not measured. */
  confirmOne(file: string): Promise<ConfirmVerdict>;
  /** File/refresh the deduped work item (assigned to `finding.assignee` when set). */
  fileRed(finding: RedFinding): Promise<{ ok: boolean; id?: string; adopted?: boolean; assignee?: string | null; error?: string; notificationError?: string }>;
  /** Newest recorded editor per file from the edit-attribution ledger, since `sinceMs`
   *  (P-002). null = unreadable; the red then routes by trailer or files unassigned. */
  lookupEditors?(files: readonly string[], sinceMs: number): Promise<EditorHit[] | null>;
  now(): number;
  log(message: string): void;
}

/**
 * File a red, routed to its author when one is known. An assignment the store
 * refuses (an unresolvable owner id, a retired session) must never cost the red
 * itself: the finding is re-filed unassigned, and the refusal is logged so the
 * routing miss stays visible. Routing is an improvement on the signal, not a
 * condition of it (D-002).
 */
export async function fileRoutedRed(
  deps: Pick<SyncBatchDeltaDeps, 'fileRed' | 'log'>,
  finding: RedFinding,
): Promise<{ ok: boolean; id?: string; adopted?: boolean; assignee?: string | null; error?: string; notificationError?: string }> {
  const res = await deps.fileRed(finding);
  if (res.ok || !finding.assignee) return res;
  deps.log(
    `[sync-batch-delta] routing to ${finding.assignee} refused (${res.error ?? 'unknown'}); re-filing unassigned`,
  );
  return deps.fileRed({ ...finding, assignee: null });
}

/** R-8 measures pickup, not the count returned by wakeRecipients. The source refs
 * identify the original filing and wake rows; missing/retained-away rows remain
 * unknown. This is the same original-population contract used by the SLO evaluators. */
export interface SyncRedDeliveryWindow {
  workspaceId: string;
  harnessSlug: string;
  windowStartMs: number;
  windowEndMs: number;
  observedAtMs: number;
  status: 'complete' | 'capped' | 'unavailable';
  total: number | null;
  rows: Array<{
    workItemId: string;
    batchSha: string | null;
    authorId: string | null;
    filingRef: string;
    redFiledAtMs: number;
    wakes: Array<{
      ref: string;
      workItemId: string;
      recipientId: string;
      queuedAtMs: number;
      deliveredAtMs: number | null;
      turnStartedAtMs: number | null;
      turnProof: string | null;
    }>;
  }>;
}

export const SYNC_RED_DELIVERY_LIMIT_MS = 15 * 60_000;

/** A closed, explicitly complete original population is necessary for healthy.
 * A measured late pickup is broken even when another row is unknown. Legacy
 * delivery-channel receipts (including inbox/coalesced) never prove a turn. */
export function evaluateSyncRedDeliveryWindow(history: SyncRedDeliveryWindow) {
  const stamp = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
  const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
  const windowValid = text(history.workspaceId) && text(history.harnessSlug) &&
    stamp(history.windowStartMs) && stamp(history.windowEndMs) &&
    history.windowStartMs < history.windowEndMs && stamp(history.observedAtMs) &&
    history.windowEndMs <= history.observedAtMs;
  const complete = history.status === 'complete' && history.total === history.rows.length &&
    history.rows.length > 0 && new Set(history.rows.map(r => r.workItemId)).size === history.rows.length &&
    new Set(history.rows.map(r => r.filingRef)).size === history.rows.length;
  const wakeRefs = new Set<string>();
  const rows = history.rows.map(row => {
    const unknown = (reason: string) => ({ workItemId: row.workItemId,
      verdict: 'unknown' as const, elapsedMs: null, reason });
    if (!windowValid || !text(row.workItemId) || !text(row.filingRef) ||
        !row.batchSha || !/^[a-f0-9]{40}$/.test(row.batchSha) || !text(row.authorId) ||
        !stamp(row.redFiledAtMs) || row.redFiledAtMs < history.windowStartMs ||
        row.redFiledAtMs > history.windowEndMs) return unknown('Original filing identity or clock is missing.');
    let invalid = false;
    let measuredMiss = false;
    const pickups: number[] = [];
    for (const wake of row.wakes) {
      if (!text(wake.ref) || wakeRefs.has(wake.ref) || wake.workItemId !== row.workItemId ||
          wake.recipientId !== row.authorId || !stamp(wake.queuedAtMs) ||
          wake.queuedAtMs < row.redFiledAtMs || wake.queuedAtMs > history.observedAtMs) {
        invalid = true; continue;
      }
      wakeRefs.add(wake.ref);
      if (wake.turnProof === 'not-picked-up' && history.observedAtMs - row.redFiledAtMs > SYNC_RED_DELIVERY_LIMIT_MS) {
        measuredMiss = true;
      }
      if (wake.deliveredAtMs === null && wake.turnStartedAtMs === null) continue;
      if (!stamp(wake.deliveredAtMs) || wake.deliveredAtMs < wake.queuedAtMs ||
          wake.deliveredAtMs > history.observedAtMs) { invalid = true; continue; }
      if (wake.turnStartedAtMs === null) continue;
      if (!['observed', 'host-attested'].includes(wake.turnProof ?? '') ||
          !stamp(wake.turnStartedAtMs) || wake.turnStartedAtMs < wake.deliveredAtMs ||
          wake.turnStartedAtMs > history.observedAtMs) { invalid = true; continue; }
      pickups.push(wake.turnStartedAtMs);
    }
    if (invalid) return unknown('Wake identity, chronology or pickup proof is invalid.');
    if (pickups.length === 0) return measuredMiss
      ? { workItemId: row.workItemId, verdict: 'broken' as const, elapsedMs: null, reason: 'Original measured missed pickup past the delivery limit.' }
      : unknown('Queued/delivered is not pickup; original turn-start proof is absent.');
    const elapsedMs = Math.min(...pickups) - row.redFiledAtMs;
    return { workItemId: row.workItemId, verdict: elapsedMs <= SYNC_RED_DELIVERY_LIMIT_MS
      ? 'healthy' as const : 'broken' as const, elapsedMs, reason: 'Original author pickup latency.' };
  });
  const verdict = rows.some(row => row.verdict === 'broken') ? 'broken' as const
    : windowValid && complete && rows.every(row => row.verdict === 'healthy') ? 'healthy' as const : 'unknown' as const;
  return { verdict, rows, assertions: [
    { id: 'bounded-sync-red-delivery-window', passed: windowValid },
    { id: 'complete-sync-red-delivery-population', passed: complete },
    { id: 'original-author-pickup-proof', passed: rows.length > 0 && rows.every(row => row.verdict !== 'unknown') },
    { id: 'author-delivery-at-most-15min', passed: verdict === 'healthy' },
  ] };
}

/** Run the clocked detector on an original ledger snapshot through the maintained
 * results writer. Fixtures only test this procedure; they are never live evidence.
 * The caller supplies its complete archived join, including all missing pickups. */
export async function executeSyncRedDeliveryWindow(history: SyncRedDeliveryWindow, args: {
  projectDir: string; runtimeUnits: string[];
}) {
  const snapshot = structuredClone(history);
  const { createHash } = await import('node:crypto');
  const { executeOperationalRun } = await import('../agent-tools/testing/record-run');
  const populationHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  return executeOperationalRun({ filePath: 'packages/operator-core/lib/release/sync-batch-delta-check.ts',
    name: 'Original sync-red author delivery latency', framework: 'operational',
    command: ['executeSyncRedDeliveryWindow', snapshot.workspaceId, snapshot.harnessSlug,
      String(snapshot.windowStartMs), String(snapshot.windowEndMs), populationHash], runtimeUnits: args.runtimeUnits,
    run: async () => {
      const result = evaluateSyncRedDeliveryWindow(snapshot);
      return { exitCode: result.verdict === 'healthy' ? 0 : 1,
        assertions: result.assertions.map(a => ({ ...a, evidence: `original_population_sha256=${populationHash}; verdict=${result.verdict}` })),
        summary: `Original sync-red delivery population: ${snapshot.rows.length}; total=${snapshot.total}; ` +
          `read=${snapshot.status}; verdict=${result.verdict}; original_population_sha256=${populationHash}; ` +
          `elapsedMs=${result.rows.map(row => row.elapsedMs ?? 'unknown').join(',')}. ` +
          'Caller snapshot provenance must be independently verified against its complete original filing/wake refs. ' +
          'No fixture, queued/woken count, or current presence substitutes for original pickup proof.' };
    },
  }, { ...args, workspaceId: snapshot.workspaceId, harnessSlug: snapshot.harnessSlug });
}

export type SyncBatchDeltaStatus =
  | 'skipped'
  | 'bootstrapped'
  | 'up-to-date'
  | 'radius-too-wide'
  /** A single commit exhausted a leg's time budget: explicitly skipped, cursor advanced. */
  | 'leg-timeout'
  /** A single commit's affected run stayed undetermined (non-zero exit, no file named)
   *  UNDETERMINED_STREAK_LIMIT times in a row: explicitly skipped, cursor advanced. */
  | 'undetermined'
  /** The oldest unjudged commit was older than STALE_BACKLOG_MS: that backlog was skipped
   *  unjudged and the cursor re-anchored near the tip (WI-6554700010018028). NOT evaluated,
   *  and never late-credited: its slot's commits were not judged. */
  | 'backlog-skipped'
  | 'nothing-selected'
  | 'green'
  | 'red';

export interface SyncBatchDeltaFiling {
  file: string;
  conditionKey: string;
  introducedBy: string | null;
  id?: string;
  adopted?: boolean;
  error?: string;
  /** Owner notification or required-wake delivery failed; the red remains retryable. */
  notificationError?: string;
}

export interface SyncBatchDeltaResult {
  status: SyncBatchDeltaStatus;
  /** Why, when the status alone does not say it. */
  reason?: string;
  /** Bounded subprocess outcome details when a verdict could not be measured. */
  diagnostic?: string;
  /** Commits consumed by this bounded prefix, including an explicit single-commit refusal. */
  batchCount: number;
  /** Unioned changed paths this run judged. */
  pathCount: number;
  /** Workspaces the radius probe selected. */
  workspaces: string[];
  /** Confirmed reds this run filed or refreshed. */
  filed: SyncBatchDeltaFiling[];
  /** Files the runner named that a single-file re-run did NOT reproduce — reported,
   *  never filed (they are the collection-abort false positives CLAUDE.md warns about). */
  unconfirmed: string[];
  /** Cursor after this run (null when the run deliberately did not advance it). */
  cursor: SyncDeltaCursor | null;
  /** How far this run's judgment reached, for coverage crediting (P-009 / D-017):
   *  `'start'` = every commit on the branch when the run started was judged; a number =
   *  every commit at or before that commit time (epoch ms) was judged and newer backlog
   *  remains. Absent = the run judged nothing older than the cursor it adopted. */
  judgedThrough?: 'start' | number;
}

/** What a bounded prefix judged: the whole backlog (`'start'`), or through its newest
 *  commit's time. An unparseable commit time judges nothing creditable. */
function judgedThroughOf(prefixCommits: readonly SyncBatch[], backlogLength: number): 'start' | number | undefined {
  if (prefixCommits.length >= backlogLength) return 'start';
  const newest = prefixCommits[prefixCommits.length - 1]?.committedAtMs;
  return typeof newest === 'number' && Number.isFinite(newest) ? newest : undefined;
}

const emptyResult =(status: SyncBatchDeltaStatus, reason?: string): SyncBatchDeltaResult => ({
  status,
  ...(reason ? { reason } : {}),
  batchCount: 0,
  pathCount: 0,
  workspaces: [],
  filed: [],
  unconfirmed: [],
  cursor: null,
});

/**
 * One tick of the sync-batch delta check.
 *
 * NEVER advances the cursor past a window it could not measure: every "I could not
 * tell" path returns `skipped` with the cursor untouched, so the next run judges
 * that window instead of it being silently skipped forever. The cursor advances
 * only after a leg actually ran — or after one individually oversized commit was
 * explicitly refused, because leaving it parked there would re-refuse the same
 * (still-growing) window forever and wedge the check permanently.
 *
 * A leg that exhausts its time budget is the same wedge in a different costume
 * (P-011: one window re-run into the same 25-minute timeout for 24h). It halves the
 * learned `windowCommitCap` so the next tick judges a smaller prefix; a single commit
 * that still exhausts the budget is explicitly skipped (`leg-timeout`). Typecheck
 * reds are filed before the affected leg runs, so they survive its timeout.
 */
export async function runSyncBatchDeltaCheck(
  deps: SyncBatchDeltaDeps,
  opts?: { caps?: RadiusCaps; maxConfirmRuns?: number; maxAttributionProbes?: number },
): Promise<SyncBatchDeltaResult> {
  // Coverage is carried from the PRE-run cursor: some inner branches rebuild the
  // cursor from scratch, which would otherwise drop the history.
  let priorCoverage: SyncDeltaCoverage | undefined;
  try {
    priorCoverage = (await deps.readCursor())?.coverage;
  } catch {
    priorCoverage = undefined;
  }
  const startedAtMs = deps.now();
  const result = await runSyncBatchDeltaTick(deps, opts);
  try {
    await recordCoverage(deps, priorCoverage, result, startedAtMs);
  } catch {
    // Coverage is an instrument, never a reason to fail the tick.
  }
  return result;
}

/** Append this tick to the coverage history and raise/refresh/clear the low-coverage
 *  alarm. A sustained low period stays ONE item (conditionKey upsert), re-filed at most
 *  hourly so its numbers stay current (maintainCoverageAlarm). */
async function recordCoverage(
  deps: SyncBatchDeltaDeps,
  prior: SyncDeltaCoverage | undefined,
  result: SyncBatchDeltaResult,
  startedAtMs: number,
): Promise<void> {
  const cursor = await deps.readCursor();
  if (!cursor?.sha) return; // nothing to annotate before the first bootstrap
  const now = deps.now();
  const tickReason = [result.reason, result.diagnostic]
    .filter((part): part is string => Boolean(part))
    .join('; ')
    .slice(0, 500);
  let coverage = recordCoverageOpportunities(
    prior,
    {
      atMs: startedAtMs,
      evaluated: isEvaluatedStatus(result.status),
      status: result.status,
      ...(!isEvaluatedStatus(result.status) && tickReason ? { reason: tickReason } : {}),
    },
    now,
  );
  // D-017 point 3: an evaluated run also judged the commits of earlier unjudged slots
  // (they sat behind the cursor it consumed). Credit those it reached within the deadline.
  if (isEvaluatedStatus(result.status) && result.judgedThrough !== undefined) {
    coverage = creditLateJudgedSlots(coverage, {
      throughMs: result.judgedThrough === 'start' ? startedAtMs : result.judgedThrough,
      judgedAtMs: now,
    });
  }
  const verdict = evaluateCoverage(coverage, now);
  coverage = await maintainCoverageAlarm(deps, coverage, verdict, now, { logLabel: 'sync-batch-delta' });
  const nextCursor = { ...cursor, coverage };
  if (result.status === 'skipped' && tickReason) {
    nextCursor.lastSkipReason = tickReason;
    nextCursor.lastSkipMs = now;
  }
  await deps.writeCursor(nextCursor);
}

interface OldestPrefixSelection {
  /** Selected in chronological order, beginning immediately after the cursor. */
  commits: SyncBatch[];
  /** Set only when the very oldest commit cannot fit the path cap by itself. */
  oversizedCommit?: { batch: SyncBatch; pathCount: number };
}

/** Select the oldest contiguous prefix within the cheap path and commit caps.
 * `listBatches` returns newest first; the cursor must stop at the last commit in
 * this chronological prefix so any newer backlog remains available next tick. */
function selectOldestBoundedPrefix(
  batchesNewestFirst: readonly SyncBatch[],
  caps: RadiusCaps,
): OldestPrefixSelection {
  const commits: SyncBatch[] = [];
  const paths = new Set<string>();
  for (let index = batchesNewestFirst.length - 1; index >= 0; index -= 1) {
    const batch = batchesNewestFirst[index]!;
    if (commits.length >= caps.maxCommits) break;
    const newPaths = new Set<string>();
    for (const changedPath of batch.paths) {
      if (changedPath && !paths.has(changedPath)) newPaths.add(changedPath);
    }
    const nextPathCount = paths.size + newPaths.size;
    if (nextPathCount > caps.maxPaths) {
      if (commits.length === 0) {
        return {
          commits: [batch],
          oversizedCommit: { batch, pathCount: unionBatchPaths([batch], caps.maxPaths).totalPaths },
        };
      }
      break;
    }
    commits.push(batch);
    for (const changedPath of newPaths) paths.add(changedPath);
  }
  return { commits };
}

/** A backlog whose OLDEST unjudged commit is older than this is no longer an early
 *  warning: the green-checkpoint gate has judged those commits since, and no coverage
 *  slot can be credited for them (COVERAGE_JUDGE_DEADLINE_MS). WI-6554700010018028: a
 *  cursor ~9,800 commits behind walked one commit per tick and could never reach a
 *  current slot, so R-17 (95% of slots judged) could not pass however often it ran.
 *  DERIVED (green-main-ratchet-convergence-2026-10-17#D-034): it was a fixed 2 h, which would
 *  drop commits a run could still have credited once the deadline grew past it. The skip is
 *  triggered this far past the credit deadline (the keep window) so a backlog merely at the
 *  deadline is walked normally: 5 slot intervals, the 25-minute gap the fixed 2 h left over
 *  the 95-minute deadline. */
export const STALE_BACKLOG_MS = COVERAGE_JUDGE_DEADLINE_MS + 5 * COVERAGE_EXPECTED_INTERVAL_MS;

/** Most commits one `listBatches` window may list. A cursor left OFF the first-parent
 *  chain (a side-lineage commit persisted before the first-parent walk, or any reset)
 *  makes `cursor..staging --first-parent` list the whole chain back to where the side
 *  lineage diverged: 110,362 commits on 2026-10-20 08:00Z. With `--name-only` that blew
 *  the git leg's timeout/buffer, so every tick returned `git-log-unreadable` and the
 *  stale-backlog skip never saw a listing (WI-6554700010018028). A listing that hits
 *  this cap is a backlog too large to walk: the planner skips it like a stale one and
 *  re-anchors the cursor on a listed (first-parent) commit. */
export const SYNC_DELTA_MAX_LISTED_COMMITS = 400;

export interface StaleBacklogSkip {
  /** Newest commit skipped unjudged; the cursor moves here. */
  anchor: SyncBatch;
  /** Commits skipped unjudged, the anchor included. A floor when `truncated`. */
  skippedCount: number;
  /** Commit time (epoch ms) of the oldest dated LISTED commit, or null when none is dated. */
  oldestMs: number | null;
  /** The listing hit SYNC_DELTA_MAX_LISTED_COMMITS: older unlisted commits were skipped too. */
  truncated: boolean;
  /** Commits left for later ticks to judge, newest first. */
  remaining: SyncBatch[];
}

/** A commit time that says something about age: parseable, and not the synthetic
 *  2000-01-01 date repair-queue admission commits carry. */
function datedMs(batch: SyncBatch): number | null {
  const t = batch.committedAtMs;
  if (typeof t !== 'number' || !Number.isFinite(t) || isAdmissionSyntheticCommitDate(t)) return null;
  return t;
}

/** Decide whether the backlog behind the cursor is stale and where to re-anchor. Pure.
 *
 *  Trigger: the oldest DATED commit is older than `staleAfterMs`. Keep: the newest-first
 *  run of commits dated within `keepWindowMs` of now (the coverage credit window); the
 *  first commit outside it (or undated) ends the run, becomes the anchor, and it and
 *  everything older are skipped unjudged. A backlog with no dated commit is never
 *  skipped: nothing proves it is stale.
 *
 *  `truncated` (the listing hit SYNC_DELTA_MAX_LISTED_COMMITS) is proof by SIZE: the
 *  skip triggers whatever the listed dates say, because the unlisted remainder is
 *  older still. When every listed commit sits inside the credit window, the oldest
 *  listed one becomes the anchor so the cursor still lands on a listed commit. */
export function planStaleBacklogSkip(
  batchesNewestFirst: readonly SyncBatch[],
  nowMs: number,
  opts: { staleAfterMs?: number; keepWindowMs?: number; truncated?: boolean } = {},
): StaleBacklogSkip | null {
  const staleAfterMs = opts.staleAfterMs ?? STALE_BACKLOG_MS;
  const keepWindowMs = opts.keepWindowMs ?? COVERAGE_JUDGE_DEADLINE_MS;
  const truncated = opts.truncated === true && batchesNewestFirst.length > 0;
  let oldestMs: number | null = null;
  for (const batch of batchesNewestFirst) {
    const t = datedMs(batch);
    if (t !== null && (oldestMs === null || t < oldestMs)) oldestMs = t;
  }
  if (!truncated && (oldestMs === null || nowMs - oldestMs <= staleAfterMs)) return null;
  const keepFrom = nowMs - keepWindowMs;
  let keep = 0;
  while (keep < batchesNewestFirst.length) {
    const t = datedMs(batchesNewestFirst[keep]!);
    if (t === null || t < keepFrom) break;
    keep += 1;
  }
  if (truncated && keep === batchesNewestFirst.length) keep -= 1;
  const anchor = batchesNewestFirst[keep];
  if (!anchor) return null;
  return {
    anchor,
    skippedCount: batchesNewestFirst.length - keep,
    oldestMs,
    truncated,
    remaining: batchesNewestFirst.slice(0, keep),
  };
}

/** Re-anchor the cursor past a stale backlog. The skipped commits are recorded as
 *  UNJUDGED (status `backlog-skipped`, never evaluated or late-credited); the kept
 *  window is judged by the next tick from a fresh cursor. A learned commit cap or an
 *  undetermined streak describes the skipped window, not the kept one, so both reset. */
async function recordStaleBacklogSkip(
  deps: SyncBatchDeltaDeps,
  cursor: SyncDeltaCursor,
  skip: StaleBacklogSkip,
  stillOpen: OpenRed[],
  filed: SyncBatchDeltaFiling[],
): Promise<SyncBatchDeltaResult> {
  const now = deps.now();
  const through = skip.anchor.sha.slice(0, 12);
  const kept = `${skip.remaining.length} recent commit(s) kept for the next tick`;
  const ageText = skip.oldestMs === null ? 'no listed commit is dated' : `oldest listed is ${Math.round((now - skip.oldestMs) / 60_000)} min old`;
  const reason = skip.truncated
    ? `at least ${skip.skippedCount} commit(s) through ${through} skipped unjudged: the listing hit ` +
      `SYNC_DELTA_MAX_LISTED_COMMITS=${SYNC_DELTA_MAX_LISTED_COMMITS} (cursor off the first-parent chain or far behind; ` +
      `${ageText}); ${kept}`
    : `${skip.skippedCount} commit(s) through ${through} skipped unjudged: ` +
      `oldest is ${Math.round((now - (skip.oldestMs ?? now)) / 60_000)} min old (> ${Math.round(STALE_BACKLOG_MS / 60_000)} min); ` +
      kept;
  const { windowCommitCap: _cap, undeterminedStreak: _streak, ...rest } = cursor;
  const next: SyncDeltaCursor = {
    ...rest,
    sha: skip.anchor.sha,
    updatedAtMs: now,
    lastSkipReason: `backlog-skipped: ${reason}`,
    lastSkipMs: now,
    openReds: stillOpen,
  };
  await deps.writeCursor(next);
  deps.log(`[sync-batch-delta] backlog-skipped: ${reason}`);
  return { ...emptyResult('backlog-skipped', reason), batchCount: skip.skippedCount, filed, cursor: next };
}

/** A single commit that cannot fit the path or workspace radius — or that exhausts
 * a leg's time budget on its own — is a bounded, non-evaluated disposition. Advance
 * only over that commit and preserve the rest of the backlog for the next tick. */
async function recordOversizedCommit(
  deps: SyncBatchDeltaDeps,
  cursor: SyncDeltaCursor,
  batch: SyncBatch,
  detail: string,
  pathCount: number,
  workspaces: string[],
  stillOpen: OpenRed[],
  filed: SyncBatchDeltaFiling[],
  opts: {
    status?: 'radius-too-wide' | 'leg-timeout' | 'undetermined';
    cursorPatch?: Partial<SyncDeltaCursor>;
    unconfirmed?: string[];
    diagnostic?: string;
  } = {},
): Promise<SyncBatchDeltaResult> {
  const status = opts.status ?? 'radius-too-wide';
  const now = deps.now();
  const reason = `commit ${batch.sha.slice(0, 12)} explicitly skipped without evaluation: ${detail}; remaining backlog retained`;
  const next: SyncDeltaCursor = {
    ...cursor,
    ...opts.cursorPatch,
    sha: batch.sha,
    updatedAtMs: now,
    lastSkipReason: `${status}: ${reason}`,
    lastSkipMs: now,
    lastBatchCommits: 1,
    openReds: stillOpen,
  };
  await deps.writeCursor(next);
  deps.log(`[sync-batch-delta] ${status}: ${reason}`);
  return {
    ...emptyResult(status, reason),
    ...(opts.diagnostic ? { diagnostic: opts.diagnostic } : {}),
    batchCount: 1,
    pathCount,
    workspaces,
    filed,
    unconfirmed: opts.unconfirmed ?? [],
    cursor: next,
  };
}

/** How many consecutive undetermined affected runs one window gets before it is shrunk
 *  (or, at one commit, explicitly skipped). Three tries absorb a transient failure. */
export const UNDETERMINED_STREAK_LIMIT = 3;

/** Outcomes that mean the leg ran out of its BUDGET (time or output), as opposed to
 *  crashing or exiting without a verdict. These are the ones a smaller window can fix. */
function isBudgetExhaustion(diagnostic: SubprocessDiagnostic | undefined): boolean {
  return diagnostic?.outcome === 'timeout' || diagnostic?.outcome === 'output-buffer-limit';
}

function describeDiagnostic(diagnostic: SubprocessDiagnostic | undefined): string {
  return diagnostic
    ? `outcome=${diagnostic.outcome} durationMs=${diagnostic.durationMs ?? 'unknown'} exitCode=${diagnostic.exitCode ?? 'unknown'}`
    : 'execution diagnostics unavailable';
}

/** The learned window cap after a MEASURED run: double it, and drop it once it is
 *  back at the static cap (exported for the unit test of the growth curve). */
export function grownWindowCommitCap(current: number | undefined, staticMaxCommits: number): number | undefined {
  if (current === undefined) return undefined;
  const doubled = Math.max(1, current) * 2;
  return doubled >= staticMaxCommits ? undefined : doubled;
}

async function runSyncBatchDeltaTick(
  deps: SyncBatchDeltaDeps,
  opts?: { caps?: RadiusCaps; maxConfirmRuns?: number; maxAttributionProbes?: number },
): Promise<SyncBatchDeltaResult> {
  const caps = opts?.caps ?? DEFAULT_RADIUS_CAPS;

  // ── 1. capacity: reserved-slice legs always; load and the gate only shrink the budget ──
  const capacity = evaluateCapacity({
    reading: deps.hostLoad(),
    gateRunning: await deps.greenCheckpointRunning(),
    fullBudget: {
      maxConfirmRuns: opts?.maxConfirmRuns ?? MAX_CONFIRM_RUNS,
      maxAttributionProbes: opts?.maxAttributionProbes ?? MAX_ATTRIBUTION_PROBES,
    },
  });
  if (capacity.mode === 'reduced') deps.log(`[sync-batch-delta] reduced budget: ${capacity.reason}`);
  const maxConfirm = capacity.budget.maxConfirmRuns;
  const maxProbes = capacity.budget.maxAttributionProbes;

  // ── 2. cursor ──────────────────────────────────────────────────────────────
  const head = await deps.headSha();
  if (!head) return emptyResult('skipped', 'git-unreadable');

  const cursor = await deps.readCursor();
  if (!cursor?.sha) {
    // First run here: adopt the tip. Scanning history backwards would judge
    // thousands of commits nobody is going to repair now.
    const next: SyncDeltaCursor = { sha: head, updatedAtMs: deps.now() };
    await deps.writeCursor(next);
    deps.log(`[sync-batch-delta] bootstrapped cursor at ${head.slice(0, 12)}`);
    return { ...emptyResult('bootstrapped'), cursor: next };
  }

  // ── 3. re-verify reds we are already holding open (bounded, cheap) ─────────
  const stillOpen: OpenRed[] = [];
  const filed: SyncBatchDeltaFiling[] = [];
  let confirmBudget = maxConfirm;
  for (const red of cursor.openReds ?? []) {
    if (confirmBudget <= 0) {
      stillOpen.push(red); // unmeasured this tick — keep holding it, never drop silently
      continue;
    }
    confirmBudget -= 1;
    const leg = red.leg ?? 'affected-tests';
    let remainsRed = false;
    if (leg === 'lint-tsc') {
      // Typecheck reds must be re-measured by the same leg. A single-file test
      // confirmation cannot prove that a typecheck failure cleared, and would
      // silently change the finding's owner/leg on the next tick.
      const tsc = await deps.runTsc([red.path]);
      if (tsc.ok || !tsc.failing.includes(red.path)) {
        // A clean run clears the red; a failed run that names another file (or
        // no file at all) is not evidence about this one, so keep it held.
        if (!tsc.ok) stillOpen.push(red);
        continue;
      }
      remainsRed = true;
    } else {
      const verdict = await deps.confirmOne(red.path);
      if (verdict === null || verdict === true) {
        // undetermined ⇒ keep holding; green ⇒ the red cleared, stop holding it.
        if (verdict === null) stillOpen.push(red);
        continue;
      }
      remainsRed = true;
    }
    if (!remainsRed) continue;
    // Still red: refresh the SAME conditionKey so the incumbent is bumped, not duplicated.
    const finding = buildRedFinding({
      failing: { file: red.path, workspace: red.workspace },
      attribution: { batch: null, how: 'unattributed', probesUsed: 0 },
      batches: [],
      leg,
      prior: red,
      author: {
        agent: red.assignee ?? null,
        source: red.authorSource ?? 'none',
      },
    });
    const res = await fileRoutedRed(deps, finding);
    filed.push({
      file: red.path,
      conditionKey: finding.conditionKey,
      introducedBy: red.introducedBy,
      ...(res.id ? { id: res.id } : {}),
      ...(res.adopted ? { adopted: true } : {}),
      ...(res.error ? { error: res.error } : {}),
      ...(res.notificationError ? { notificationError: res.notificationError } : {}),
    });
    stillOpen.push({
      ...red,
      ...(res.assignee !== undefined ? { assignee: res.assignee } : {}),
      confirmations: red.confirmations + 1,
    });
  }

  if (cursor.sha === head) {
    const next: SyncDeltaCursor = { ...cursor, sha: head, updatedAtMs: deps.now(), openReds: stillOpen };
    await deps.writeCursor(next);
    return { ...emptyResult('up-to-date'), filed, cursor: next, judgedThrough: 'start' };
  }

  // ── 4. the new batch window ────────────────────────────────────────────────
  const batches = await deps.listBatches(cursor.sha);
  if (!batches) return emptyResult('skipped', 'git-log-unreadable');
  if (batches.length === 0) {
    const next: SyncDeltaCursor = { ...cursor, sha: head, updatedAtMs: deps.now(), openReds: stillOpen };
    await deps.writeCursor(next);
    return { ...emptyResult('up-to-date'), filed, cursor: next, judgedThrough: 'start' };
  }

  // A backlog too old to warn about or to earn coverage is skipped, never walked.
  const staleSkip = planStaleBacklogSkip(batches, deps.now(), {
    truncated: batches.length >= SYNC_DELTA_MAX_LISTED_COMMITS,
  });
  if (staleSkip) return recordStaleBacklogSkip(deps, cursor, staleSkip, stillOpen, filed);

  // A cap learned from earlier leg timeouts narrows the window below the static one.
  const learnedCap = cursor.windowCommitCap;
  const windowCaps: RadiusCaps =
    learnedCap !== undefined && learnedCap < caps.maxCommits ? { ...caps, maxCommits: Math.max(1, learnedCap) } : caps;
  let prefix = selectOldestBoundedPrefix(batches, windowCaps);
  if (prefix.oversizedCommit) {
    const { batch, pathCount } = prefix.oversizedCommit;
    return recordOversizedCommit(
      deps,
      cursor,
      batch,
      `${pathCount} changed paths in this single commit exceeds maxPaths=${caps.maxPaths}`,
      pathCount,
      [],
      stillOpen,
      filed,
    );
  }
  if (prefix.commits.length === 0) return emptyResult('skipped', 'radius-prefix-empty');

  let selectedBatches = [...prefix.commits].reverse(); // newest first for attribution helpers
  let union = unionBatchPaths(selectedBatches, caps.maxPaths);
  if (union.paths.length === 0) {
    const next: SyncDeltaCursor = {
      ...cursor,
      sha: prefix.commits[prefix.commits.length - 1]!.sha,
      updatedAtMs: deps.now(),
      lastBatchCommits: selectedBatches.length,
      openReds: stillOpen,
    };
    await deps.writeCursor(next);
    const judgedThrough = judgedThroughOf(prefix.commits, batches.length);
    return {
      ...emptyResult('nothing-selected', 'no changed paths'),
      batchCount: selectedBatches.length,
      filed,
      cursor: next,
      ...(judgedThrough !== undefined ? { judgedThrough } : {}),
    };
  }

  // ── 5. radius probe + the cap ──────────────────────────────────────────────
  let probe: AffectedProbe = { workspaces: [], guards: [], taskCommands: [], derivation: null };
  let verdict: RadiusVerdict;
  for (;;) {
    if (union.paths.length === 0) {
      probe = { workspaces: [], guards: [], taskCommands: [], derivation: null };
      verdict = { run: false, reason: 'nothing-selected', detail: 'oldest prefix has no changed paths' };
      break;
    }
    const measured = await deps.probeRadius(union.paths);
    if (!measured) return emptyResult('skipped', 'radius-probe-failed');
    probe = measured;
    verdict = evaluateRadius({ probe, union, batchCount: selectedBatches.length, caps });
    if (verdict.run || verdict.reason !== 'radius-too-wide') break;
    if (prefix.commits.length === 1) {
      const batch = prefix.commits[0]!;
      return recordOversizedCommit(
        deps,
        cursor,
        batch,
        `this single commit selects workspaces=${probe.workspaces.length}, tasks=${probe.taskCommands.length}, ` +
          `guards=${probe.guards.length}; ${verdict.detail}`,
        union.paths.length,
        probe.workspaces,
        stillOpen,
        filed,
      );
    }
    // Halving the chronological prefix bounds extra enumeration probes to
    // floor(log2(maxCommits)) + 1 (six with the production cap of 40). The
    // oldest commit stays at the front; newer work remains behind the cursor.
    prefix = { commits: prefix.commits.slice(0, Math.max(1, Math.floor(prefix.commits.length / 2))) };
    selectedBatches = [...prefix.commits].reverse();
    union = unionBatchPaths(selectedBatches, caps.maxPaths);
  }
  if (!verdict.run) {
    const next: SyncDeltaCursor = {
      ...cursor,
      sha: prefix.commits[prefix.commits.length - 1]!.sha,
      updatedAtMs: deps.now(),
      lastSkipReason: verdict.reason,
      lastSkipMs: deps.now(),
      lastBatchCommits: selectedBatches.length,
      openReds: stillOpen,
    };
    await deps.writeCursor(next);
    deps.log(`[sync-batch-delta] ${verdict.reason}: ${verdict.detail}`);
    const judgedThrough = verdict.reason === 'nothing-selected' ? judgedThroughOf(prefix.commits, batches.length) : undefined;
    return {
      status: verdict.reason,
      reason: verdict.detail,
      batchCount: selectedBatches.length,
      pathCount: union.paths.length,
      workspaces: probe.workspaces,
      filed,
      unconfirmed: [],
      cursor: next,
      ...(judgedThrough !== undefined ? { judgedThrough } : {}),
    };
  }

  // ── 6. execute the two legs — typecheck FIRST, and file its reds at once ───
  // Sequential on purpose: these are the two heaviest subprocesses on the box, and
  // running them concurrently would double the load the radius cap exists to bound.
  //
  // tsc runs first and its reds are confirmed, attributed and filed BEFORE the
  // affected leg starts (green-main-cycle-time-2026-10-08 P-011). The affected leg is
  // the one that exhausts its 25-minute budget under load; when it ran first, an
  // undetermined affected run returned early and DISCARDED a measured typecheck
  // verdict, so a window with a heavy affected radius never surfaced a type error.
  // Filing before the long leg also bounds a type error's time-to-red to the tsc
  // budget, not tsc + affected.
  const unconfirmed: string[] = [];
  let probeBudget = maxProbes;
  const alreadyOpen = new Set(stillOpen.map((r) => r.path));
  const commonResult = () => ({
    batchCount: selectedBatches.length,
    pathCount: union.paths.length,
    workspaces: probe.workspaces,
    filed,
    unconfirmed,
  });
  /** Persist the cursor at the SAME sha with the reds held so far, so a later tick
   *  re-verifies them instead of re-filing them. `updatedAtMs` is untouched: it
   *  records the last ADVANCE, and this is not one. */
  const holdCursor = async (patch: Partial<SyncDeltaCursor> = {}): Promise<SyncDeltaCursor> => {
    const held: SyncDeltaCursor = { ...cursor, ...patch, openReds: stillOpen };
    await deps.writeCursor(held);
    return held;
  };
  /** A leg exhausted its budget on this window. A smaller window is the fix: halve the
   *  learned cap so the next tick judges an older, smaller prefix. A SINGLE commit that
   *  exhausts the budget cannot shrink further, so it is explicitly skipped and the
   *  cursor advances past it (the oversized-commit disposition), instead of re-running
   *  the identical window into the identical timeout forever. */
  const shrinkWindowOnBudgetExhaustion = async (
    leg: 'affected-tests' | 'lint-tsc',
    diagnostic: string,
  ): Promise<SyncBatchDeltaResult> => {
    if (prefix.commits.length === 1) {
      return recordOversizedCommit(
        deps,
        cursor,
        prefix.commits[0]!,
        `the ${leg} leg exhausted its budget on this single commit (${diagnostic})`,
        union.paths.length,
        probe.workspaces,
        stillOpen,
        filed,
        { status: 'leg-timeout', cursorPatch: { windowCommitCap: 1 }, unconfirmed, diagnostic },
      );
    }
    const halved = Math.max(1, Math.floor(prefix.commits.length / 2));
    const reason = `${leg}-budget-exhausted: window halved from ${prefix.commits.length} to ${halved} commit(s)`;
    const held = await holdCursor({ windowCommitCap: halved, lastSkipReason: reason, lastSkipMs: deps.now() });
    deps.log(`[sync-batch-delta] ${reason}; ${diagnostic}; cursor held`);
    return { ...emptyResult('skipped', reason), ...commonResult(), diagnostic, cursor: held };
  };

  const fileCandidates = async (
    candidates: ReadonlyArray<{ failing: FailingFile; leg: 'affected-tests' | 'lint-tsc' }>,
  ): Promise<void> => {
    for (const cand of candidates) {
      if (alreadyOpen.has(cand.failing.file)) continue;
      if (cand.leg === 'affected-tests') {
        if (confirmBudget <= 0) {
          unconfirmed.push(cand.failing.file);
          continue;
        }
        confirmBudget -= 1;
        const v = await deps.confirmOne(cand.failing.file);
        if (v === null || v === true) {
          // undetermined, or green on its own — CLAUDE.md: never attribute a batch
          // verdict to every file it named.
          unconfirmed.push(cand.failing.file);
          continue;
        }
      }

      const attribution = await attributeIntroducingBatch({
        batches: selectedBatches,
        failing: cand.failing,
        probeBatch: async (paths) => {
          if (probeBudget <= 0) return null;
          probeBudget -= 1;
          return deps.probeRadius(paths);
        },
        maxProbes: probeBudget,
      });
      // P-002: route to the editing agent. Ledger rows are looked up from the oldest
      // batch in the window (minus a margin: the edit precedes its sweep commit).
      const oldestMs = selectedBatches.reduce<number | null>(
        (m, b) => (b.committedAtMs === null ? m : m === null ? b.committedAtMs : Math.min(m, b.committedAtMs)),
        null,
      );
      const lookupFiles = [cand.failing.file, ...(attribution.batch?.paths ?? [])];
      let editors: EditorHit[] | null = null;
      if (deps.lookupEditors) {
        try {
          editors = await deps.lookupEditors(lookupFiles, (oldestMs ?? deps.now()) - EDITOR_LOOKBACK_MARGIN_MS);
        } catch {
          editors = null;
        }
      }
      const author = pickRedAuthor({ failingFile: cand.failing.file, batch: attribution.batch, editors });
      const finding = buildRedFinding({
        failing: cand.failing,
        attribution,
        batches: selectedBatches,
        leg: cand.leg,
        author,
      });
      const res = await fileRoutedRed(deps, finding);
      filed.push({
        file: cand.failing.file,
        conditionKey: finding.conditionKey,
        introducedBy: attribution.batch?.sha ?? null,
        ...(res.id ? { id: res.id } : {}),
        ...(res.adopted ? { adopted: true } : {}),
        ...(res.error ? { error: res.error } : {}),
        ...(res.notificationError ? { notificationError: res.notificationError } : {}),
      });
      stillOpen.push({
        path: cand.failing.file,
        workspace: cand.failing.workspace,
        introducedBy: attribution.batch?.sha ?? null,
        leg: cand.leg,
        assignee: res.assignee ?? author.agent,
        authorSource: author.source,
        firstSeenMs: deps.now(),
        confirmations: 1,
      });
      alreadyOpen.add(cand.failing.file);
    }
  };

  // 6a. typecheck
  const tsFiles = tsFilesOf(union.paths);
  const tsc = tsFiles.length > 0 ? await deps.runTsc(tsFiles) : { ok: true, failing: [] as string[] };
  if (!tsc.ok && tsc.failing.length === 0) {
    const diagnostic = describeDiagnostic(tsc.diagnostic);
    if (isBudgetExhaustion(tsc.diagnostic)) return shrinkWindowOnBudgetExhaustion('lint-tsc', diagnostic);
    // Crashed or exited without naming a file: NOT MEASURED, the next tick re-judges.
    deps.log(`[sync-batch-delta] tsc run undetermined; ${diagnostic}; cursor held`);
    const held = await holdCursor();
    return { ...emptyResult('skipped', 'tsc-undetermined'), ...commonResult(), diagnostic, cursor: held };
  }
  const openBeforeTsc = stillOpen.length;
  await fileCandidates(tsc.failing.map((file) => ({ failing: { file, workspace: null }, leg: 'lint-tsc' as const })));
  // Persist the typecheck reds before the long leg, so a tick killed mid-affected-run
  // (routine timeout, restart) re-verifies them next time instead of re-filing them.
  if (stillOpen.length > openBeforeTsc) await holdCursor();

  // 6b. affected tests
  const affected = await deps.runAffected(union.paths);
  if (!affected.ok) {
    if (affected.failing === null || affected.failing.length === 0) {
      // Missing or explicitly empty terminal break-set ⇒ no measured file-level verdict.
      // NOT MEASURED: do not advance or call this green. The typecheck reds above are
      // already filed and held; the window is re-judged (smaller, if the budget ran out).
      const breakSet = affected.failing === null ? 'missing-terminal-break-set' : 'empty-terminal-break-set';
      const diagnostic = describeDiagnostic(affected.diagnostic);
      if (isBudgetExhaustion(affected.diagnostic)) return shrinkWindowOnBudgetExhaustion('affected-tests', diagnostic);
      // Bound the re-runs (WI-6554700010017999): a transient failure gets
      // UNDETERMINED_STREAK_LIMIT tries on the same window; a deterministic one then
      // shrinks the window and finally skips the single commit, like a budget timeout.
      const windowHead = prefix.commits[prefix.commits.length - 1]!.sha;
      const prior = cursor.undeterminedStreak;
      const count = prior?.windowHead === windowHead ? prior.count + 1 : 1;
      if (count >= UNDETERMINED_STREAK_LIMIT) {
        const why = `affected run undetermined (${breakSet}) ${count} times in a row on this window (${diagnostic})`;
        if (prefix.commits.length === 1) {
          return recordOversizedCommit(
            deps,
            cursor,
            prefix.commits[0]!,
            why,
            union.paths.length,
            probe.workspaces,
            stillOpen,
            filed,
            { status: 'undetermined', cursorPatch: { windowCommitCap: 1, undeterminedStreak: undefined }, unconfirmed, diagnostic },
          );
        }
        const halved = Math.max(1, Math.floor(prefix.commits.length / 2));
        const reason = `affected-run-undetermined-repeatedly: window halved from ${prefix.commits.length} to ${halved} commit(s)`;
        const held = await holdCursor({
          windowCommitCap: halved,
          undeterminedStreak: undefined,
          lastSkipReason: reason,
          lastSkipMs: deps.now(),
        });
        deps.log(`[sync-batch-delta] ${reason}; ${why}; cursor held`);
        return { ...emptyResult('skipped', reason), ...commonResult(), diagnostic, cursor: held };
      }
      deps.log(`[sync-batch-delta] affected run undetermined (${breakSet}, ${count}/${UNDETERMINED_STREAK_LIMIT}); ${diagnostic}; cursor held`);
      const held = await holdCursor({ undeterminedStreak: { windowHead, count } });
      return { ...emptyResult('skipped', `affected-run-${breakSet}`), ...commonResult(), diagnostic, cursor: held };
    }
    // ── 7. confirm, attribute, file ──────────────────────────────────────────
    await fileCandidates(affected.failing.map((failing) => ({ failing, leg: 'affected-tests' as const })));
  }

  // Both legs measured this window: grow the learned cap back toward the static one.
  const grownCap = grownWindowCommitCap(cursor.windowCommitCap, caps.maxCommits);
  const judgedSha = prefix.commits[prefix.commits.length - 1]!.sha;
  // P-012: a known-good point only when BOTH legs were green as run (an unconfirmed red is still
  // a red leg) and nothing is held open — otherwise the previous known-good point is carried.
  const passed = tsc.ok && affected.ok && filed.length === 0 && stillOpen.length === 0;
  const lastPassed: KnownGoodPoint | undefined = passed
    ? { sha: judgedSha, atMs: deps.now() }
    : cursor.lastPassed;
  const next: SyncDeltaCursor = {
    sha: judgedSha,
    updatedAtMs: deps.now(),
    lastBatchCommits: selectedBatches.length,
    openReds: stillOpen,
    ...(grownCap !== undefined ? { windowCommitCap: grownCap } : {}),
    ...(lastPassed ? { lastPassed } : {}),
  };
  await deps.writeCursor(next);

  const red = filed.length > 0;
  deps.log(
    `[sync-batch-delta] ${selectedBatches.length} commit(s), ${union.paths.length} path(s), ` +
      `${probe.workspaces.length} workspace(s) -> ${red ? `${filed.length} red filed/refreshed` : 'green'}`,
  );
  const judgedThrough = judgedThroughOf(prefix.commits, batches.length);
  return {
    status: red ? 'red' : 'green',
    batchCount: selectedBatches.length,
    pathCount: union.paths.length,
    workspaces: probe.workspaces,
    filed,
    unconfirmed,
    cursor: next,
    ...(judgedThrough !== undefined ? { judgedThrough } : {}),
  };
}

