/**
 * `sync-batch-lint-guards.ts` — the repo-wide lint guards, run on every git-sync batch
 * (green-main-cycle-time-2026-10-08 P-028; audit rpt_0b337850 rec 1; extends P-011).
 *
 * WHY: the per-sync delta check (`sync-batch-delta-check.ts`) runs only typecheck and the
 * affected tests. The gate's repo-wide lint guards (`lowMemoryLintSpecs` in
 * `apps/operator/lib/release/green-checkpoint.ts`) judge the WHOLE tree, so a new violation
 * of one of them first surfaced at the hourly gate and re-redded a frozen candidate. On
 * 2026-10-13 all 5 red legs of the current freeze were such guards. This module runs the
 * same guards per sync batch, so a new violation is attributed and routed to its author
 * within one tick instead of hours later.
 *
 * WHAT COUNTS AS NEW. A guard is judged against ITS OWN last measurement, never against
 * "green": several guards are red on any given day, and a red guard is still able to gain
 * a new offender. Each measurement records the repo-relative paths named in the guard's
 * output. A new violation is
 *   - a path the guard names now and did not name last time, or
 *   - a pass -> fail flip whose output names no path (filed unattributed).
 * A guard measured for the first time is a BASELINE: it files nothing, because its existing
 * offenders predate this check and are the gate's (already owned) business.
 *
 * ROUTING reuses the P-011 path unchanged: `pickRedAuthor` (edit-attribution ledger first,
 * then the `Papercusp-Agent` trailer of the newest batch that touched the path) and
 * `fileRoutedRed` (a work-item assigned to that author; refused assignment re-files
 * unassigned). The guards run on the shared WORKING tree, so an offender may still be
 * uncommitted; the edit ledger attributes it either way.
 *
 * NEVER A FALSE RED. A timeout, a spawn failure, a Node crash (stack frames in the output)
 * or a missing script/database is UNDETERMINED: the guard keeps its prior record and is
 * re-measured next tick. Only an exit that looks like the guard's own verdict is a fail.
 *
 * COVERAGE (green-main-ratchet-convergence-2026-10-17 P-009 / R-8). Every tick records its
 * five-minute schedule slot on the state (`coverage`, the delta check's machinery): judged
 * only when every guard gave a verdict, credited later when a following tick judges it
 * within 30 minutes. 24h coverage below 95% files one `sync-lint-guards-coverage-low` item.
 *
 * Pure: every IO seam is `SyncLintGuardDeps`; the binding is `sync-batch-lint-guards-deps.ts`
 * and the cadence is the `sync-batch-lint-guards` routine (its own 5-minute row, so a
 * 25-minute affected leg in the delta check can never delay a guard red).
 */
import {
  creditLateJudgedSlots,
  evaluateCapacity,
  evaluateCoverage,
  EDITOR_LOOKBACK_MARGIN_MS,
  fileRoutedRed,
  maintainCoverageAlarm,
  pickRedAuthor,
  recordCoverageOpportunities,
  SYNC_DELTA_SLA_MINUTES,
  type AuthorSource,
  type CoverageAlarmSubject,
  type CoverageTick,
  type EditorHit,
  type RedFinding,
  type SubprocessDiagnostic,
  type SyncBatch,
  type SyncBatchDeltaDeps,
  type SyncDeltaCoverage,
} from './sync-batch-delta-check';

/** `filedBy` on every item this routine files (re-exported by the deps binding). */
export const SYNC_LINT_GUARDS_FILED_BY = 'system:sync-batch-lint-guards';

/**
 * The gate's low-memory repo-wide lint guards, in the gate's order. PINNED to
 * `lowMemoryLintSpecs` in `apps/operator/lib/release/green-checkpoint.ts` by
 * `sync-batch-lint-guards.test.ts`: a guard added to the gate without being added here
 * fails that test, so the shift-left cannot silently fall behind the gate.
 */
export const SYNC_LINT_GUARD_SCRIPTS = [
  'lint:no-owner-name-tags',
  'lint:no-box-identity',
  'lint:no-identity-literals',
  'lint:design-primitives',
  'lint:no-control-bytes',
  'lint:guard-reachability',
  'lint:condition-rail',
  'lint:mock-cast-escape',
  'lint:timer-classification',
  'lint:no-raw-setinterval',
] as const;

export type SyncLintGuardScript = (typeof SYNC_LINT_GUARD_SCRIPTS)[number];

/** Guards run at most this many at once (each is a whole-tree scan at idle priority). */
export const GUARD_CONCURRENCY = 3;
/** New-violation filings per tick. The rest stay out of the baseline and file next tick. */
export const MAX_GUARD_FILINGS_PER_TICK = 6;
/** Offending paths kept per guard record (a guard red on hundreds of files is not a
 *  baseline anyone can diff usefully past this; the cap is reported on the record). */
export const MAX_OFFENDERS_PER_GUARD = 400;
/** Output kept for a finding body. */
const EXCERPT_LINES = 12;

/** One guard invocation as the binding observed it. `null` exit = not measured. */
export interface GuardRun {
  exitCode: number | null;
  /** stdout + stderr, SGR-stripped. */
  output: string;
  diagnostic?: SubprocessDiagnostic;
}

export type GuardVerdict = 'pass' | 'fail' | 'undetermined';

/** What one guard last measured. */
export interface GuardRecord {
  status: 'pass' | 'fail';
  /** Repo-relative paths the guard's output named (capped at MAX_OFFENDERS_PER_GUARD). */
  offenders: string[];
  /** True when `offenders` was cut at the cap. */
  offendersTruncated?: boolean;
  /** Integration-branch tip when this record was measured: the start of the next
   *  attribution window for THIS guard. */
  sha: string;
  atMs: number;
}

/** Durable state, stored on the routine's own row (`routines.metadata.sync_lint_guards`). */
export interface SyncLintGuardState {
  /** Tip at the last tick that measured anything. */
  sha: string;
  atMs: number;
  guards: Partial<Record<SyncLintGuardScript, GuardRecord>>;
  lastSkipReason?: string;
  lastSkipMs?: number;
  /** Per-slot coverage history + the low-coverage alarm state (P-009 / R-8), recorded by
   *  `runSyncLintGuardTick` with the delta check's coverage machinery. */
  coverage?: SyncDeltaCoverage;
}

export interface SyncLintGuardDeps
  extends Pick<
    SyncBatchDeltaDeps,
    'hostLoad' | 'greenCheckpointRunning' | 'headSha' | 'listBatches' | 'fileRed' | 'lookupEditors' | 'now' | 'log'
  > {
  readGuardState(): Promise<SyncLintGuardState | null>;
  writeGuardState(next: SyncLintGuardState): Promise<void>;
  /** `npm run <script>` in the integration tree, at idle priority, time-bounded. */
  runGuard(script: SyncLintGuardScript): Promise<GuardRun>;
  /** Absolute repo root, stripped from absolute paths a guard prints. */
  repoRoot: string;
}

// ── output parsing ───────────────────────────────────────────────────────────

/** A Node stack frame: the guard crashed, it did not judge. */
const STACK_FRAME_RE = /^\s+at \S.*:\d+:\d+\)?\s*$/m;
/** Environmental failures that say nothing about the tree. */
const ENVIRONMENT_FAILURE_RE = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOMEM|Missing script:|command not found|Cannot find module/;

/** Classify a run. A non-zero exit is a FAIL only when it looks like the guard's own verdict. */
export function classifyGuardRun(run: GuardRun, script?: SyncLintGuardScript): GuardVerdict {
  const outcome = run.diagnostic?.outcome;
  if (outcome === 'timeout' || outcome === 'output-buffer-limit' || outcome === 'spawn-error') return 'undetermined';
  if (run.exitCode === null) return 'undetermined';
  if (run.exitCode === 0) return 'pass';
  // Every measured design-lint violation is emitted as a structured assertion
  // record by scripts/test-files.mjs. A nonzero exit without one is a runner or
  // harness failure, not evidence that a source file violates a design rule.
  if (script === 'lint:design-primitives' &&
    !run.output.split(/\r?\n/).some((line) => line.startsWith('TEST_FILE_ASSERTION_FAILURE file='))) {
    return 'undetermined';
  }
  if (
    STACK_FRAME_RE.test(run.output) ||
    structuredAssertionHasStackFrame(run.output) ||
    ENVIRONMENT_FAILURE_RE.test(run.output)
  ) return 'undetermined';
  return 'fail';
}

/** A repo-relative file path token: at least one directory and an extension. */
const PATH_TOKEN_RE = /(?:^|[\s'"`(,=])((?:\/[^\s'"`()]+?)|(?:[A-Za-z0-9_@.+\-[\]]+(?:\/[A-Za-z0-9_@.+\-[\]]+)+))\.([A-Za-z0-9]{1,8})(?=$|[\s'"`):,;])/gm;
/** `check-no-identity-literals` prints one machine-readable-ish file header per hit. */
const IDENTITY_LITERAL_DIAGNOSTIC_RE = /^\s{2}(.+?\.[A-Za-z0-9]{1,8}):\d+\s+\[[^\]]+\]\s*$/;
/** `check-no-box-identity` prints `path:line (user "…")` before the matched source line. */
const BOX_IDENTITY_DIAGNOSTIC_RE = /^  (.+):\d+  \(user "[^"]+"\)\s*$/;
/** The owner-name-tag checker prints the matched path before its rendered finding. */
const OWNER_NAME_TAG_DIAGNOSTIC_RE =
  /^\s{2}(.+?\.[A-Za-z0-9]{1,8}):\d+\s+(?:\[owner:[^\]]+\]|OWNER … \([^)]+\))\s*$/;

/** Structured paths emitted by scripts/test-files.mjs for measured assertion failures. */
const TEST_FILE_ASSERTION_FAILURE_FILE_RE = /^TEST_FILE_ASSERTION_FAILURE file=("(?:\\.|[^"\\])*")(?:\s|$)/;
const TEST_FILE_ASSERTION_FAILURE_MESSAGE_RE = /\smessage=("(?:\\.|[^"\\])*")(?:\s|$)/;

/** The test-file runner JSON-escapes assertion messages, so runner stack frames in
 * `message=` are not visible to STACK_FRAME_RE until that field is decoded. */
function structuredAssertionHasStackFrame(output: string): boolean {
  for (const line of output.split(/\r?\n/)) {
    const match = TEST_FILE_ASSERTION_FAILURE_MESSAGE_RE.exec(line);
    if (!match) continue;
    try {
      const message: unknown = JSON.parse(match[1]!);
      if (typeof message === 'string' && STACK_FRAME_RE.test(message)) return true;
    } catch {
      // A malformed assertion record is not evidence of a source violation here.
    }
  }
  return false;
}

/** Design lint's writer lists source paths relative to apps/, while file= names its test. */
function designLintMessageOffenders(line: string): string[] {
  const match = TEST_FILE_ASSERTION_FAILURE_MESSAGE_RE.exec(line);
  if (!match) return [];
  try {
    const message: unknown = JSON.parse(match[1]);
    if (typeof message !== 'string') return [];
    const list = /found in unapproved files:\r?\n([\s\S]*?)(?:\r?\n\r?\n|$)/.exec(message)?.[1];
    if (!list) return [];
    return list.split(/\r?\n/).map((p) => p.trim())
      .filter((p) => /^(?:operator|operator-vite)\/[A-Za-z0-9_@.+\-[\]/]+\.[A-Za-z0-9]{1,8}$/.test(p) && !p.split('/').includes('..'))
      .map((p) => `apps/${p}`);
  } catch {
    return [];
  }
}

function normalizeGuardOffenderPath(path: string, root: string): string | null {
  let p = path;
  if (p.startsWith('/')) {
    if (!p.startsWith(root)) return null;
    p = p.slice(root.length);
  }
  if (
    !p ||
    p === '(unknown file)' ||
    p.includes('node_modules/') ||
    p.includes('://') ||
    (p.startsWith('.') && !p.startsWith('.papercusp/'))
  ) {
    return null;
  }
  return p;
}

/**
 * The repo-relative paths a guard's failure evidence names, de-duplicated in first-seen order.
 * Design lint's explicit message list names its source offenders; file= names the lint itself.
 * For other guards, when the test-file runner emits structured assertion records, use file=;
 * other output can contain unrelated source paths from loader and runner instrumentation.
 * Otherwise, preserve the path-token parser used by the other lint guards. Absolute paths under
 * `repoRoot` are made relative; any other absolute path, a `node_modules` path and a URL are dropped.
 */
export function parseGuardOffenders(output: string, repoRoot: string, script?: SyncLintGuardScript): string[] {
  const root = repoRoot.endsWith('/') ? repoRoot : `${repoRoot}/`;
  const seen = new Set<string>();
  const out: string[] = [];
  const assertionFailureLines = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith('TEST_FILE_ASSERTION_FAILURE file='));
  const candidates: string[] = [];
  if (script === 'lint:no-owner-name-tags') {
    // Its explanation names audit-release-bundle.py, and its source excerpts may
    // contain paths too. Only the path:line + renderLeak header is an offender.
    for (const line of output.split(/\r?\n/)) {
      const match = OWNER_NAME_TAG_DIAGNOSTIC_RE.exec(line);
      if (match) candidates.push(match[1]!);
    }
  } else if (script === 'lint:no-identity-literals') {
    // The finding's source excerpt can itself contain paths (for example a JSON `scope`
    // field naming a declaration file). Only the checker’s `path:line [key]` header
    // identifies the file that actually matched the build-box identity.
    for (const line of output.split(/\r?\n/)) {
      const match = IDENTITY_LITERAL_DIAGNOSTIC_RE.exec(line);
      if (match) candidates.push(match[1]!);
    }
  } else if (script === 'lint:no-box-identity') {
    // The following source excerpt can contain paths unrelated to the finding (for example
    // a JSON field naming a declaration file). Only the checker's diagnostic header counts.
    for (const line of output.split(/\r?\n/)) {
      const match = BOX_IDENTITY_DIAGNOSTIC_RE.exec(line);
      if (match) candidates.push(match[1]!);
    }
  } else if (assertionFailureLines.length > 0) {
    for (const line of assertionFailureLines) {
      if (script === 'lint:design-primitives') {
        candidates.push(...designLintMessageOffenders(line));
        continue;
      }
      const match = TEST_FILE_ASSERTION_FAILURE_FILE_RE.exec(line);
      if (!match) continue;
      try {
        const path: unknown = JSON.parse(match[1]);
        if (typeof path === 'string') candidates.push(path);
      } catch {
        // A malformed structured record is not permission to fall back to unrelated path tokens.
      }
    }
  } else if (script !== 'lint:design-primitives') {
    for (const m of output.matchAll(PATH_TOKEN_RE)) candidates.push(`${m[1]}.${m[2]}`);
  }
  for (const candidate of candidates) {
    const p = normalizeGuardOffenderPath(candidate, root);
    if (p === null) continue;
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

// ── new-violation diff ───────────────────────────────────────────────────────

/** One new violation. `path: null` = a pass -> fail flip whose output named no file. */
export interface NewViolation {
  script: SyncLintGuardScript;
  path: string | null;
}

/** The new violations one guard measurement shows against that guard's prior record. */
export function diffGuardViolations(
  script: SyncLintGuardScript,
  prior: GuardRecord | undefined,
  verdict: GuardVerdict,
  offenders: readonly string[],
): NewViolation[] {
  if (verdict !== 'fail' || !prior) return [];
  if (prior.status === 'pass') {
    return offenders.length === 0 ? [{ script, path: null }] : offenders.map((path) => ({ script, path }));
  }
  const before = new Set(prior.offenders);
  // A truncated prior record cannot prove a path is new: only judge within its coverage.
  if (prior.offendersTruncated) return [];
  return offenders.filter((p) => !before.has(p)).map((path) => ({ script, path }));
}

// ── the filed finding ────────────────────────────────────────────────────────

export function conditionKeyForGuardViolation(v: NewViolation): string {
  return `sync-delta-guard:${v.script}:${v.path ?? '*'}`;
}

/** The output lines about `path` (or the head of the output when there is no path). */
export function guardExcerpt(output: string, path: string | null): string[] {
  const lines = output.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  const assertions = lines.filter((line) => line.startsWith('TEST_FILE_ASSERTION_FAILURE file='));
  const relevant = assertions.filter((line) => !path || line.includes(path) ||
    (path.startsWith('apps/') && line.includes(path.slice('apps/'.length))));
  if (relevant.length > 0) return relevant.slice(0, EXCERPT_LINES);
  if (path) {
    const idx = lines.findIndex((l) => l.includes(path));
    if (idx >= 0) return lines.slice(idx, idx + 4);
  }
  return lines.slice(0, EXCERPT_LINES);
}

export function buildGuardFinding(input: {
  violation: NewViolation;
  output: string;
  batch: SyncBatch | null;
  windowCommits: number;
  author: { agent: string | null; source: AuthorSource };
  slaMinutes?: number;
}): RedFinding {
  const { violation, batch, author } = input;
  const sla = input.slaMinutes ?? SYNC_DELTA_SLA_MINUTES;
  const subject = violation.path ?? '(no file named by the guard)';
  const lines = [
    `The repo-wide guard \`npm run ${violation.script}\` has a NEW violation on the shared \`staging\` tree.`,
    'The green-checkpoint runs this guard over the whole tree, so the next frozen candidate goes red on it',
    'unless it is fixed first.',
    '',
    `Guard:     ${violation.script}`,
    `Offender:  ${subject}`,
    violation.path
      ? 'New because: the guard did not name this path at its previous measurement.'
      : 'New because: the guard passed at its previous measurement and now fails without naming a file.',
    `Window:    ${input.windowCommits} commit(s) since that measurement`,
    batch
      ? `Batch that touched it: ${batch.sha} (Papercusp-Agent trailer: ${batch.agent ?? '(none)'})`
      : 'Batch that touched it: none in the window (the edit may still be uncommitted).',
    '',
    author.agent
      ? `Routed to: ${author.agent} (source: ${author.source}). Nothing was reverted. This is an alert.`
      : 'Routed to: nobody. No ledgered editor or trailer names an author. Claim it if it is yours.',
    '',
    'Guard output (excerpt):',
    ...guardExcerpt(input.output, violation.path).map((l) => `    ${l.slice(0, 300)}`),
    '',
    `SLA: fix or revert within ${sla} minutes, before the hourly green-checkpoint freezes a candidate on it.`,
    `Repair: run \`npm run ${violation.script}\`, fix what it names, and re-run it to confirm the fix.`,
    '',
    `Filed by \`system:sync-batch-lint-guards\` (conditionKey \`${conditionKeyForGuardViolation(
      violation,
    )}\`; refreshed in place, never re-filed as a sibling).`,
  ];
  return {
    conditionKey: conditionKeyForGuardViolation(violation),
    title: `sync-batch guard red: ${violation.script} (${subject})`,
    body: lines.join('\n'),
    paths: [...(violation.path ? [violation.path] : []), ...(batch?.paths ?? [])]
      .filter((p, i, a) => a.indexOf(p) === i)
      .slice(0, 40),
    assignee: author.agent,
    authorSource: author.source,
  };
}

// ── the tick ─────────────────────────────────────────────────────────────────

export type SyncLintGuardStatus = 'skipped' | 'bootstrapped' | 'up-to-date' | 'measured';

export interface SyncLintGuardFiling {
  script: SyncLintGuardScript;
  path: string | null;
  conditionKey: string;
  assignee: string | null;
  authorSource: AuthorSource;
  id?: string;
  adopted?: boolean;
  error?: string;
  /** Filing succeeded but the targeted wake still needs the next tick. */
  notificationError?: string;
}

export interface SyncLintGuardResult {
  status: SyncLintGuardStatus;
  reason?: string;
  verdicts: Partial<Record<SyncLintGuardScript, GuardVerdict>>;
  filed: SyncLintGuardFiling[];
  /** New violations held back by the per-tick cap or a failed filing (filed next tick). */
  deferred: NewViolation[];
  state: SyncLintGuardState | null;
}

const empty = (status: SyncLintGuardStatus, reason?: string): SyncLintGuardResult => ({
  status,
  ...(reason ? { reason } : {}),
  verdicts: {},
  filed: [],
  deferred: [],
  state: null,
});

async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * One tick. Runs every guard when the tip moved since the last measuring tick, diffs each
 * against its own prior record, files at most MAX_GUARD_FILINGS_PER_TICK routed findings,
 * and stores the new records. A guard that could not be measured keeps its prior record.
 * Then records this schedule slot's coverage and raises or clears the low-coverage alarm
 * (P-009 / R-8). Coverage never fails the tick.
 */
export async function runSyncLintGuardTick(
  deps: SyncLintGuardDeps,
  opts?: { scripts?: readonly SyncLintGuardScript[]; maxFilings?: number },
): Promise<SyncLintGuardResult> {
  const startedAtMs = deps.now();
  const result = await measureSyncLintGuards(deps, opts);
  try {
    const annotated = await recordLintGuardCoverage(deps, result, startedAtMs, opts?.scripts ?? SYNC_LINT_GUARD_SCRIPTS);
    if (annotated && result.state) return { ...result, state: annotated };
  } catch (e) {
    deps.log(`[sync-lint-guards] coverage not recorded: ${e instanceof Error ? e.message : String(e)}`);
  }
  return result;
}

// ── coverage (P-009 / R-8) ───────────────────────────────────────────────────

/** This routine's slot-credit deadline. It stays the original fixed 30 minutes (D-017 #3):
 *  green-main-ratchet-convergence-2026-10-17#D-031 derives the DELTA check's deadline from
 *  that check's own probe/tsc/affected leg budgets, which do not describe a guard tick. */
export const LINT_GUARDS_JUDGE_DEADLINE_MS = 30 * 60_000;

/** The lint-guard routine's coverage alarm: one open item, upserted by condition key. */
export const LINT_GUARDS_COVERAGE_ALARM_SUBJECT: CoverageAlarmSubject = {
  conditionKey: 'sync-lint-guards-coverage-low',
  label: 'sync-batch lint guards',
  judgeDeadlineMs: LINT_GUARDS_JUDGE_DEADLINE_MS,
  filedBy: SYNC_LINT_GUARDS_FILED_BY,
  stateHint:
    'Read metadata.sync_lint_guards with a workspace-scoped dev:pg_query; routines:list does not return it ' +
    '(lastSkipReason and coverage.ticks[].reason carry bounded diagnostics; `partial` names the guards that gave no verdict).',
  path: 'packages/operator-core/lib/release/sync-batch-lint-guards.ts',
};

/**
 * The coverage slot one tick produced. A slot is judged only when every guard gave a
 * verdict: `up-to-date` (every guard already measured this tip), or a `measured` /
 * `bootstrapped` tick with no undetermined guard. A tick where some guard gave no verdict
 * is `partial` and not judged; those guards keep their older records, so a later tick
 * that measures them can credit the slot within the deadline.
 */
export function lintGuardCoverageTick(
  result: Pick<SyncLintGuardResult, 'status' | 'reason' | 'verdicts'>,
  scripts: readonly SyncLintGuardScript[],
  atMs: number,
): CoverageTick {
  if (result.status === 'skipped') {
    return { atMs, evaluated: false, status: 'skipped', ...(result.reason ? { reason: result.reason.slice(0, 500) } : {}) };
  }
  const undetermined = scripts.filter((s) => result.verdicts[s] === 'undetermined');
  if (undetermined.length > 0) {
    return { atMs, evaluated: false, status: 'partial', reason: `undetermined: ${undetermined.join(', ')}`.slice(0, 500) };
  }
  return { atMs, evaluated: true, status: result.status };
}

/** Append this tick's slot (plus any slots missed while no tick completed), credit
 *  earlier unjudged slots this tick judged within the deadline, and raise the alarm on
 *  the transition into low coverage (one item per low period) or clear it on recovery.
 *  Returns the written state, or null when there is no state to annotate yet. */
async function recordLintGuardCoverage(
  deps: SyncLintGuardDeps,
  result: SyncLintGuardResult,
  startedAtMs: number,
  scripts: readonly SyncLintGuardScript[],
): Promise<SyncLintGuardState | null> {
  const state = await deps.readGuardState();
  if (!state) return null;
  const now = deps.now();
  const tick = lintGuardCoverageTick(result, scripts, startedAtMs);
  let coverage = recordCoverageOpportunities(state.coverage, tick, now);
  // A judged tick measured every guard at the tip it read after starting, so every
  // commit at or before its start was judged.
  if (tick.evaluated) {
    coverage = creditLateJudgedSlots(coverage, {
      throughMs: startedAtMs,
      judgedAtMs: now,
      deadlineMs: LINT_GUARDS_JUDGE_DEADLINE_MS,
    });
  }
  const verdict = evaluateCoverage(coverage, now);
  coverage = await maintainCoverageAlarm(deps, coverage, verdict, now, {
    subject: LINT_GUARDS_COVERAGE_ALARM_SUBJECT,
    logLabel: 'sync-lint-guards',
  });
  const next: SyncLintGuardState = { ...state, coverage };
  await deps.writeGuardState(next);
  return next;
}

/** The measuring half of a tick (no coverage). */
async function measureSyncLintGuards(
  deps: SyncLintGuardDeps,
  opts?: { scripts?: readonly SyncLintGuardScript[]; maxFilings?: number },
): Promise<SyncLintGuardResult> {
  const scripts = opts?.scripts ?? SYNC_LINT_GUARD_SCRIPTS;
  const maxFilings = opts?.maxFilings ?? MAX_GUARD_FILINGS_PER_TICK;

  const capacity = evaluateCapacity({
    reading: deps.hostLoad(),
    gateRunning: await deps.greenCheckpointRunning(),
    fullBudget: { maxConfirmRuns: 0, maxAttributionProbes: 0 },
  });
  const prior = await deps.readGuardState();
  const recordSkip = async (reason: string): Promise<SyncLintGuardResult> => {
    if (prior) await deps.writeGuardState({ ...prior, lastSkipReason: reason, lastSkipMs: deps.now() });
    deps.log(`[sync-lint-guards] skip: ${reason}`);
    return empty('skipped', reason);
  };
  // P-009 / D-017: load never skips the guards (they run in the reserved slice); it is
  // only logged. The guard leg has no confirm/attribution budget for it to shrink.
  if (capacity.mode === 'reduced') deps.log(`[sync-lint-guards] running under load: ${capacity.reason}`);

  const head = await deps.headSha();
  if (!head) return recordSkip('git-unreadable');
  // A tick may advance its overall sha while a timed-out guard or deferred
  // filing retains an older per-guard record. Those records still need a
  // retry at this same head; only a completely measured batch is up to date.
  if (prior && prior.sha === head && scripts.every((script) => prior.guards[script]?.sha === head)) {
    return { ...empty('up-to-date'), state: prior };
  }

  // Measure every guard (bounded concurrency; each one idle-priority in the binding).
  const runs = await mapBounded(scripts, GUARD_CONCURRENCY, async (script) => {
    let run: GuardRun;
    try {
      run = await deps.runGuard(script);
    } catch (e) {
      run = { exitCode: null, output: e instanceof Error ? e.message : String(e) };
    }
    const verdict = classifyGuardRun(run, script);
    const offenders = verdict === 'fail' ? parseGuardOffenders(run.output, deps.repoRoot, script) : [];
    return { script, run, verdict, offenders };
  });

  const now = deps.now();
  const verdicts: Partial<Record<SyncLintGuardScript, GuardVerdict>> = {};
  for (const r of runs) verdicts[r.script] = r.verdict;
  if (runs.every((r) => r.verdict === 'undetermined')) {
    return { ...(await recordSkip('all-guards-undetermined')), verdicts };
  }

  // New violations, per guard, against that guard's own prior record.
  const candidates: Array<{ violation: NewViolation; output: string; sinceSha: string; sinceMs: number }> = [];
  for (const r of runs) {
    const record = prior?.guards[r.script];
    for (const violation of diffGuardViolations(r.script, record, r.verdict, r.offenders)) {
      candidates.push({ violation, output: r.run.output, sinceSha: record!.sha, sinceMs: record!.atMs });
    }
  }

  // Attribution windows: one `listBatches` per distinct starting sha (usually one).
  const windows = new Map<string, SyncBatch[]>();
  for (const c of candidates) {
    if (windows.has(c.sinceSha)) continue;
    let batches: SyncBatch[] | null = null;
    try {
      batches = await deps.listBatches(c.sinceSha);
    } catch {
      batches = null;
    }
    windows.set(c.sinceSha, batches ?? []);
  }

  const filed: SyncLintGuardFiling[] = [];
  const deferred: NewViolation[] = [];
  for (const c of candidates) {
    if (filed.filter((f) => !f.error).length >= maxFilings) {
      deferred.push(c.violation);
      continue;
    }
    const batches = windows.get(c.sinceSha) ?? [];
    const path = c.violation.path;
    const batch = path ? (batches.find((b) => b.paths.includes(path)) ?? null) : batches.length === 1 ? batches[0]! : null;
    let editors: EditorHit[] | null = null;
    if (deps.lookupEditors && path) {
      try {
        editors = await deps.lookupEditors([path, ...(batch?.paths ?? [])], c.sinceMs - EDITOR_LOOKBACK_MARGIN_MS);
      } catch {
        editors = null;
      }
    }
    const author = pickRedAuthor({ failingFile: path ?? '', batch, editors });
    const finding = buildGuardFinding({ violation: c.violation, output: c.output, batch, windowCommits: batches.length, author });
    // fileRoutedRed re-files unassigned when the store refuses the owner; record the
    // assignee the store actually accepted, not the one first proposed.
    let usedAssignee = finding.assignee;
    const res = await fileRoutedRed(
      {
        log: deps.log,
        fileRed: (f) => {
          usedAssignee = f.assignee;
          return deps.fileRed(f);
        },
      },
      finding,
    );
    filed.push({
      script: c.violation.script,
      path,
      conditionKey: finding.conditionKey,
      assignee: res.ok ? ('assignee' in res ? res.assignee ?? null : usedAssignee) : null,
      authorSource: author.source,
      ...(res.id ? { id: res.id } : {}),
      ...(res.adopted ? { adopted: true } : {}),
      ...(res.notificationError ? { notificationError: res.notificationError } : {}),
      ...(res.ok ? {} : { error: res.error ?? 'file-failed' }),
    });
    if (!res.ok || res.notificationError) deferred.push(c.violation);
  }

  // New records. A deferred offender stays OUT of its guard's baseline so the next tick
  // still sees it as new; an undetermined guard keeps its prior record untouched.
  const deferredKeys = new Set(deferred.map((v) => conditionKeyForGuardViolation(v)));
  const guards: SyncLintGuardState['guards'] = { ...(prior?.guards ?? {}) };
  for (const r of runs) {
    if (r.verdict === 'undetermined') continue;
    const priorRecord = prior?.guards[r.script];
    const heldBack = r.offenders.filter((p) => deferredKeys.has(conditionKeyForGuardViolation({ script: r.script, path: p })));
    const flipHeldBack = deferredKeys.has(conditionKeyForGuardViolation({ script: r.script, path: null }));
    const kept = r.offenders.filter((p) => !heldBack.includes(p));
    guards[r.script] = flipHeldBack && priorRecord
      ? priorRecord
      : {
          status: r.verdict === 'pass' ? 'pass' : 'fail',
          offenders: kept.slice(0, MAX_OFFENDERS_PER_GUARD),
          ...(kept.length > MAX_OFFENDERS_PER_GUARD ? { offendersTruncated: true } : {}),
          sha: heldBack.length > 0 && priorRecord ? priorRecord.sha : head,
          atMs: heldBack.length > 0 && priorRecord ? priorRecord.atMs : now,
        };
  }
  // The coverage history belongs to the routine, not to this measurement: carry it over.
  const state: SyncLintGuardState = { sha: head, atMs: now, guards, ...(prior?.coverage ? { coverage: prior.coverage } : {}) };
  await deps.writeGuardState(state);

  const fails = runs.filter((r) => r.verdict === 'fail').map((r) => r.script);
  deps.log(
    `[sync-lint-guards] ${prior ? 'measured' : 'bootstrapped'} at ${head.slice(0, 12)}: ` +
      `${fails.length} red guard(s)${fails.length ? ` (${fails.join(', ')})` : ''}, ` +
      `${filed.length} filing(s), ${deferred.length} deferred`,
  );
  return { status: prior ? 'measured' : 'bootstrapped', verdicts, filed, deferred, state };
}
