/**
 * Periodic full-suite run of `main` (green-main-ratchet-convergence-2026-10-17 P-013, R-11, D-016).
 *
 * WHY. The gate runs only the radius affected since the last promotion (AFFECTED_BASE in
 * green-checkpoint.ts), so a break in a test outside every radius promotes unseen and
 * surfaces later against an unrelated change. D-004 measured it: 86% of new failures in
 * steps where the frozen count rose were tests the previous measurement never ran. This
 * run closes that door. On a cadence it runs the WHOLE suite at main's tip, finds the
 * failures that were not failing at the previous full run, attributes each to a single
 * promotion by bisecting the promotions in between, and routes it to fix, eject or
 * downgrade (the D-002 response order).
 *
 * PURE. Every decision lives here and is unit-tested in periodic-full-run.test.ts. The IO
 * seams (git, the clean-tree test runs, work-item filing, the routine-row state) are the
 * `PeriodicFullRunDeps` interface, bound in periodic-full-run-deps.ts.
 *
 * Attribution (D-003's blame check, applied to promotions). For each new failing file:
 *   1. re-run it at main's tip — a pass there means the full-run red was a flip, routed to
 *      the flaky quarantine instead of a culprit;
 *   2. re-run it at the previous full run's sha (the baseline) — a fail there means the
 *      break has no code change behind it (time, environment, an external service), so
 *      there is no promotion to blame;
 *   3. binary search over the promotions between baseline and tip. The invariant is
 *      "passes at points[lo], fails at points[hi]", so the result is always a single
 *      promotion that passes on the base without it: the blame check by construction.
 * Probes are grouped by sha (one clean-tree run per sha covers every file whose next
 * midpoint is that sha) and bounded by `maxProbeRuns`; a bisection the budget cannot
 * finish is reported unattributable ('budget-exhausted'), never guessed.
 *
 * Capacity (R-11 falsifier 3). Every leg runs in the reserved `source-checks.slice` that
 * P-009 introduced (`reservedCapacityArgv`), and this module has NO host-load skip: the
 * deps interface does not even carry a load reading, so load shedding cannot starve it.
 */
import type { FailingFile as GateFailingFile } from './sync-batch-delta-check';
import { reservedCapacityArgv } from './sync-batch-delta-check';

/** The runner's failing-file entry plus, when the run reported them, its failed case names
 *  (P-017: case names ride on every failing row). */
export interface FailingFile extends GateFailingFile {
  cases?: string[];
}

/** Cadence (critique of R-11: an unscheduled backstop attributes nothing). The routine fires
 *  every 30 minutes and runs the suite when this much time has passed since the last full
 *  run, so a full run happens at least every 6h while the routine is live. */
export const PERIODIC_FULL_RUN_INTERVAL_MS = 6 * 60 * 60_000;
/** Bound on bisection cost: distinct clean-tree probe runs per full run. Tip + baseline
 *  confirms are 2 runs; 64 promotions bisect in 6 more. */
export const PERIODIC_FULL_RUN_MAX_PROBE_RUNS = 16;
/** A route that has not resolved its failure by the next full run after this long escalates
 *  one step along fix -> eject -> downgrade. */
export const PERIODIC_FULL_RUN_ESCALATE_AFTER_MS = 24 * 60 * 60_000;

export interface Promotion {
  sha: string;
  atMs: number;
}

/**
 * Parse `git reflog show --format=%H%x09%ct <main>` (newest first) into promotions,
 * oldest first. The release ref only moves by green-checkpoint's fast-forward, so each
 * reflog entry is one promotion. A repeated sha (a no-op reset) is kept once, at its first
 * appearance in time order.
 */
export function parseMainReflog(text: string): Promotion[] {
  const rows: Promotion[] = [];
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{40})\t(\d+)\s*$/.exec(line.trim());
    if (m) rows.push({ sha: m[1], atMs: Number(m[2]) * 1000 });
  }
  rows.reverse();
  const seen = new Set<string>();
  const out: Promotion[] = [];
  for (const row of rows) {
    if (seen.has(row.sha)) continue;
    seen.add(row.sha);
    out.push(row);
  }
  return out;
}

/** The bisection points: the baseline (previous full run's sha) followed by every promotion
 *  after it, ending at main's tip. `null` when the baseline is not in the promotion history
 *  (the reflog expired, or main was rewritten): nothing can be bisected, and the caller
 *  reports every new failure unattributable ('no-baseline'). */
export function bisectionPoints(history: readonly Promotion[], baselineSha: string, tipSha: string): string[] | null {
  const shas = history.map((p) => p.sha);
  const from = shas.indexOf(baselineSha);
  const to = shas.lastIndexOf(tipSha);
  if (from < 0 || to < 0 || to < from) return null;
  return shas.slice(from, to + 1);
}

/** A file failing in this full run that was not failing in the previous one, with the cases
 *  that are new (every case when the file is newly red). A file still failing with only the
 *  same cases is CARRIED: already routed, so it escalates instead of being bisected again.
 *  Files with an active downgrade/quarantine record are excluded: they are non-blocking. */
export interface FailureDelta {
  fresh: FailingFile[];
  carried: FailingFile[];
  resolved: string[];
}

export function failureDelta(input: {
  previous: readonly FailingFile[];
  current: readonly FailingFile[];
  isExcluded?: (file: string) => boolean;
}): FailureDelta {
  const excluded = input.isExcluded ?? (() => false);
  const prev = new Map(input.previous.map((f) => [f.file, f] as const));
  const fresh: FailingFile[] = [];
  const carried: FailingFile[] = [];
  const currentFiles = new Set<string>();
  for (const f of input.current) {
    currentFiles.add(f.file);
    if (excluded(f.file)) continue;
    const before = prev.get(f.file);
    if (!before) {
      fresh.push(f);
      continue;
    }
    const known = new Set(before.cases ?? []);
    const newCases = (f.cases ?? []).filter((c) => !known.has(c));
    if (newCases.length > 0) fresh.push({ ...f, cases: newCases });
    else carried.push(f);
  }
  const resolved = input.previous.map((f) => f.file).filter((file) => !currentFiles.has(file));
  return { fresh, carried, resolved };
}

export type Unattributable = 'flaky-at-tip' | 'fails-at-baseline' | 'no-baseline' | 'probe-undetermined' | 'budget-exhausted';

export type Attribution =
  | { file: string; kind: 'attributed'; culprit: string; previous: string; probes: number }
  | { file: string; kind: 'unattributable'; reason: Unattributable; probes: number };

/** One clean-tree run of `files` at `sha`: per-file verdict, `null` = undetermined (an absent
 *  TEST_FILE_RESULT line, `matched=0`, a collection abort). Never coerce null to pass/fail. */
export type RunFilesAt = (sha: string, files: readonly string[]) => Promise<Map<string, boolean | null>>;

interface BisectState {
  file: string;
  phase: 'tip' | 'base' | 'bisect' | 'done';
  lo: number;
  hi: number;
  probes: number;
  result?: Attribution;
}

function nextSha(state: BisectState, points: readonly string[]): string | null {
  if (state.phase === 'tip') return points[points.length - 1];
  if (state.phase === 'base') return points[0];
  if (state.phase === 'bisect') return points[Math.floor((state.lo + state.hi) / 2)];
  return null;
}

function finish(state: BisectState, result: Attribution): void {
  state.phase = 'done';
  state.result = result;
}

/**
 * Attribute each fresh failure to a single promotion. `points[0]` is the baseline (passing
 * at the previous full run), `points[last]` is the tip (failing now). Probe runs are grouped
 * by sha, largest group first, at most `maxProbeRuns` distinct runs in total.
 */
export async function attributeFailures(input: {
  files: readonly string[];
  points: readonly string[] | null;
  runFilesAt: RunFilesAt;
  maxProbeRuns?: number;
}): Promise<{ attributions: Attribution[]; probeRuns: number }> {
  const budget = input.maxProbeRuns ?? PERIODIC_FULL_RUN_MAX_PROBE_RUNS;
  const points = input.points;
  if (!points || points.length < 2) {
    const reason: Unattributable = points && points.length === 1 ? 'fails-at-baseline' : 'no-baseline';
    // One point means main has not moved since the previous full run: the file passed there
    // and fails now with no promotion in between, so the break has no code change to blame.
    return {
      attributions: input.files.map((file) => ({ file, kind: 'unattributable', reason, probes: 0 })),
      probeRuns: 0,
    };
  }
  const states: BisectState[] = input.files.map((file) => ({ file, phase: 'tip', lo: 0, hi: points.length - 1, probes: 0 }));
  let probeRuns = 0;
  for (;;) {
    const groups = new Map<string, BisectState[]>();
    for (const s of states) {
      const sha = nextSha(s, points);
      if (sha === null) continue;
      const g = groups.get(sha) ?? [];
      g.push(s);
      groups.set(sha, g);
    }
    if (groups.size === 0) break;
    const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    for (const [sha, group] of ordered) {
      if (probeRuns >= budget) {
        for (const s of states) if (s.phase !== 'done') finish(s, { file: s.file, kind: 'unattributable', reason: 'budget-exhausted', probes: s.probes });
        break;
      }
      probeRuns += 1;
      const verdicts = await input.runFilesAt(sha, group.map((s) => s.file));
      for (const s of group) {
        s.probes += 1;
        const v = verdicts.get(s.file) ?? null;
        if (v === null) {
          finish(s, { file: s.file, kind: 'unattributable', reason: 'probe-undetermined', probes: s.probes });
          continue;
        }
        if (s.phase === 'tip') {
          if (v) finish(s, { file: s.file, kind: 'unattributable', reason: 'flaky-at-tip', probes: s.probes });
          else s.phase = 'base';
        } else if (s.phase === 'base') {
          if (!v) finish(s, { file: s.file, kind: 'unattributable', reason: 'fails-at-baseline', probes: s.probes });
          else s.phase = 'bisect';
        } else {
          const mid = Math.floor((s.lo + s.hi) / 2);
          if (v) s.lo = mid;
          else s.hi = mid;
        }
        if (s.phase === 'bisect' && s.hi - s.lo <= 1) {
          finish(s, { file: s.file, kind: 'attributed', culprit: points[s.hi], previous: points[s.lo], probes: s.probes });
        }
      }
    }
    if (probeRuns >= budget && states.some((s) => s.phase !== 'done')) {
      for (const s of states) if (s.phase !== 'done') finish(s, { file: s.file, kind: 'unattributable', reason: 'budget-exhausted', probes: s.probes });
    }
  }
  return { attributions: states.map((s) => s.result!), probeRuns };
}

export type Route = 'fix' | 'eject' | 'downgrade';

export interface RouteRecord {
  route: Route;
  sinceMs: number;
  culprit: string | null;
  itemId?: string | null;
}

/**
 * The D-002 response order as an escalation ladder. A fresh attributed failure goes to FIX
 * (a bug to the culprit promotion). If it is still failing once the route is older than
 * `escalateAfterMs`, it escalates to EJECT (revert the culprit's change on staging; valid
 * because bisection proved it passes without that promotion), then to DOWNGRADE (a record
 * with reason, owner and bug; a critical-area test also needs the D-006 acknowledgement).
 * Unattributable failures have no promotion to eject: a flip goes straight to the flaky
 * quarantine (a downgrade kind, D-015); anything else is FIX, then DOWNGRADE.
 */
export function routeFailure(input: {
  attribution: Attribution;
  prior: RouteRecord | null;
  nowMs: number;
  escalateAfterMs?: number;
}): RouteRecord & { escalated: boolean; reason: string } {
  const after = input.escalateAfterMs ?? PERIODIC_FULL_RUN_ESCALATE_AFTER_MS;
  const a = input.attribution;
  const culprit = a.kind === 'attributed' ? a.culprit : null;
  if (a.kind === 'unattributable' && a.reason === 'flaky-at-tip') {
    return { route: 'downgrade', sinceMs: input.prior?.route === 'downgrade' ? input.prior.sinceMs : input.nowMs, culprit, itemId: input.prior?.itemId ?? null, escalated: false, reason: 'verdict flipped at tip: flaky quarantine (D-015)' };
  }
  const prior = input.prior;
  if (!prior) {
    return { route: 'fix', sinceMs: input.nowMs, culprit, itemId: null, escalated: false, reason: culprit ? `attributed to promotion ${culprit.slice(0, 10)}` : `unattributable (${a.kind === 'unattributable' ? a.reason : ''})` };
  }
  const stale = input.nowMs - prior.sinceMs >= after;
  if (!stale || prior.route === 'downgrade') {
    return { ...prior, culprit: prior.culprit ?? culprit, escalated: false, reason: `still on ${prior.route}` };
  }
  const next: Route = prior.route === 'fix' && (prior.culprit ?? culprit) ? 'eject' : 'downgrade';
  return { route: next, sinceMs: input.nowMs, culprit: prior.culprit ?? culprit, itemId: prior.itemId ?? null, escalated: true, reason: `${prior.route} unresolved after ${Math.round((input.nowMs - prior.sinceMs) / 3_600_000)}h` };
}

/** Due when no full run has completed yet, or the cadence interval has passed. */
export function fullRunDue(input: { lastFullRunAtMs: number | null; nowMs: number; intervalMs?: number }): boolean {
  if (input.lastFullRunAtMs === null) return true;
  return input.nowMs - input.lastFullRunAtMs >= (input.intervalMs ?? PERIODIC_FULL_RUN_INTERVAL_MS);
}

/** The whole-suite leg's payload: the full suite in a clean tree at `sha`. */
export function fullRunPayload(sha: string): { cmd: string; args: string[] } {
  return { cmd: 'npm', args: ['run', '--silent', 'lint:as-committed', '--', 'test:all', `--ref=${sha}`] };
}

/** One bisection probe's payload: ONE file in a clean tree at `sha`. One file per invocation,
 *  because a multi-file run can abort at collection and its result must not be attributed
 *  to every requested path (root CLAUDE.md, gate failure triage). */
export function probePayload(sha: string, file: string): { cmd: string; args: string[] } {
  return { cmd: 'npm', args: ['run', '--silent', 'lint:as-committed', '--', 'test:file', `--ref=${sha}`, '--', file] };
}

/** The whole-suite leg inside the reserved slice (R-11 falsifier 3). The deps run the payload
 *  through `runReservedArgv`, which wraps it exactly like this and records a fallback. */
export function fullRunArgv(sha: string): { cmd: string; args: string[] } {
  const p = fullRunPayload(sha);
  return reservedCapacityArgv(p.cmd, p.args);
}

/** One bisection probe inside the reserved slice. */
export function probeArgv(sha: string, file: string): { cmd: string; args: string[] } {
  const p = probePayload(sha, file);
  return reservedCapacityArgv(p.cmd, p.args);
}

export interface FullRunState {
  lastFullRun: { sha: string; atMs: number; failing: FailingFile[] } | null;
  routes: Record<string, RouteRecord>;
}

export type FullSuiteResult = { status: 'measured'; failing: FailingFile[] } | { status: 'inconclusive'; reason: string };

export interface PeriodicFullRunDeps {
  now(): number;
  readState(): Promise<FullRunState>;
  writeState(state: FullRunState): Promise<void>;
  mainSha(): Promise<string>;
  promotions(): Promise<Promotion[]>;
  runFullSuite(sha: string): Promise<FullSuiteResult>;
  runFilesAt: RunFilesAt;
  /** True when the file has an active downgrade/quarantine record (non-blocking). */
  isExcluded(file: string): Promise<boolean>;
  /** File or update the one deduped work-item for this failure's current route. */
  fileRoute(input: { file: string; failing: FailingFile; attribution: Attribution | null; route: ReturnType<typeof routeFailure> }): Promise<string | null>;
  log(line: string): void;
}

export type PeriodicFullRunReport =
  | { status: 'not-due' }
  | { status: 'inconclusive'; sha: string; reason: string }
  | { status: 'baseline-recorded'; sha: string; failing: number }
  | { status: 'judged'; sha: string; baseline: string; fresh: number; carried: number; resolved: number; probeRuns: number; attributions: Attribution[]; routed: Array<{ file: string; route: Route; escalated: boolean }> };

export async function runPeriodicFullRun(deps: PeriodicFullRunDeps, opts: { force?: boolean; maxProbeRuns?: number } = {}): Promise<PeriodicFullRunReport> {
  const nowMs = deps.now();
  const state = await deps.readState();
  if (!opts.force && !fullRunDue({ lastFullRunAtMs: state.lastFullRun?.atMs ?? null, nowMs })) return { status: 'not-due' };
  const tip = await deps.mainSha();
  const full = await deps.runFullSuite(tip);
  if (full.status === 'inconclusive') {
    // The baseline does not move on an inconclusive run: like with like (D-004).
    deps.log(`[periodic-full-run] inconclusive at ${tip.slice(0, 10)}: ${full.reason}`);
    return { status: 'inconclusive', sha: tip, reason: full.reason };
  }
  if (!state.lastFullRun) {
    await deps.writeState({ lastFullRun: { sha: tip, atMs: nowMs, failing: full.failing }, routes: state.routes });
    return { status: 'baseline-recorded', sha: tip, failing: full.failing.length };
  }
  const excluded = new Set<string>();
  for (const f of full.failing) if (await deps.isExcluded(f.file)) excluded.add(f.file);
  const delta = failureDelta({ previous: state.lastFullRun.failing, current: full.failing, isExcluded: (file) => excluded.has(file) });
  const points = bisectionPoints(await deps.promotions(), state.lastFullRun.sha, tip);
  const { attributions, probeRuns } = await attributeFailures({
    files: delta.fresh.map((f) => f.file),
    points,
    runFilesAt: deps.runFilesAt,
    maxProbeRuns: opts.maxProbeRuns,
  });
  const routes: Record<string, RouteRecord> = {};
  const routed: Array<{ file: string; route: Route; escalated: boolean }> = [];
  const byFile = new Map(full.failing.map((f) => [f.file, f] as const));
  for (const a of attributions) {
    const decision = routeFailure({ attribution: a, prior: state.routes[a.file] ?? null, nowMs });
    const itemId = await deps.fileRoute({ file: a.file, failing: byFile.get(a.file)!, attribution: a, route: decision });
    routes[a.file] = { route: decision.route, sinceMs: decision.sinceMs, culprit: decision.culprit, itemId: itemId ?? decision.itemId ?? null };
    routed.push({ file: a.file, route: decision.route, escalated: decision.escalated });
  }
  for (const f of delta.carried) {
    const prior = state.routes[f.file] ?? null;
    const carriedAttribution: Attribution = prior?.culprit
      ? { file: f.file, kind: 'attributed', culprit: prior.culprit, previous: prior.culprit, probes: 0 }
      : { file: f.file, kind: 'unattributable', reason: 'fails-at-baseline', probes: 0 };
    const decision = routeFailure({ attribution: carriedAttribution, prior, nowMs });
    if (decision.escalated || !prior) {
      const itemId = await deps.fileRoute({ file: f.file, failing: f, attribution: prior ? null : carriedAttribution, route: decision });
      routes[f.file] = { route: decision.route, sinceMs: decision.sinceMs, culprit: decision.culprit, itemId: itemId ?? decision.itemId ?? null };
    } else {
      routes[f.file] = prior;
    }
    routed.push({ file: f.file, route: routes[f.file].route, escalated: decision.escalated });
  }
  await deps.writeState({ lastFullRun: { sha: tip, atMs: nowMs, failing: full.failing }, routes });
  return {
    status: 'judged',
    sha: tip,
    baseline: state.lastFullRun.sha,
    fresh: delta.fresh.length,
    carried: delta.carried.length,
    resolved: delta.resolved.length,
    probeRuns,
    attributions,
    routed,
  };
}
