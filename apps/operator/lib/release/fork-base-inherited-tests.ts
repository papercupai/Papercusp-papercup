/**
 * Plan slack-asana-reproduced-bug-fix-pr-workflow-2026-10-08 #D-066 (WI-6554700010019508).
 *
 * A review-mode (fork) pot's gate selects tests against its upstream merge-base (#D-064), but
 * any fork delta that touches a workspace selects that workspace's whole test task, so the
 * fork inherits every test that is ALREADY red on upstream content (measured on drill run
 * a9992c54: 23 operator-core files, all red upstream). #D-065 only inherited non-test legs, so
 * such a fork could never reach green while its upstream is red.
 *
 * Rule (#D-066): a failing TEST FILE is inherited (non-blocking) when it also fails re-run at
 * the fork's selection base, and that base is upstream content (an ancestor of the upstream
 * tracking ref). A file that passes at the base is the fork's own new failure and blocks.
 * A `<ws>` or `<ws> :: test*` entry inherits only when every located failing file in that
 * workspace inherited. Every other entry (a task with no located file, a build sentinel, a
 * lint leg) is not covered and blocks.
 *
 * Mechanism: the candidate checkout is turned into the base's tracked content by reverting
 * ONLY the fork's delta paths in place (`git checkout <base> -- …`), each failing file is
 * re-run alone with the gate's own isolation runner, and the delta is restored. This replaces
 * #D-066's first idea (re-materialize the tree at base, then again at the candidate): that is
 * two ~8 min setups, and the drill run reaches its suite verdict ~2h15m into a 3h ceiling.
 * The overlay keeps the candidate's installed dependencies, so it refuses any delta that can
 * change them: a package.json, .gitmodules, .npmrc, a gitlink, or a lockfile change that is
 * not flag-only churn ("dev"/"devOptional"/"optional"/"peer").
 *
 * Fail closed everywhere: no upstream install or ref, no base, base == candidate, a base that
 * is not upstream content, an aborted/timed-out/undetermined suite, an uncovered entry, too
 * little time left, a refused delta, a runner error, or a file that was not re-run all keep the
 * red exactly as measured. A failed RESTORE is reported to the caller, which must not judge
 * the tree afterwards.
 *
 * Known limit (disclosed in #D-066): file granularity. A NEW error inside a file that already
 * fails at the base is not detected. Upstream's own gate still judges the merged change before
 * upstream main moves.
 */
import type { FailingFile, IsolationResult } from './green-checkpoint';

/** Start the base re-runs only with at least this much of the run's ceiling left: the
 *  re-runs (~10-15 min for ~20 files), then the post-suite legs (~15-20 min measured), then
 *  the post-verdict steps all have to fit. */
export const FORK_BASE_INHERITANCE_MIN_START_MS = 35 * 60_000;

/** Stop STARTING new file re-runs below this much remaining time. A file not re-run counts as
 *  not inherited, so the red stands (partial-but-real, never a guessed green). */
export const FORK_BASE_INHERITANCE_STOP_STARTING_MS = 25 * 60_000;

/** A fork delta larger than this is not overlaid (bounds argv and the revert itself). */
export const FORK_BASE_OVERLAY_MAX_PATHS = 500;

const UPSTREAM_REF_PREFIX = 'refs/remotes/';

/** Paths whose change can alter installed dependencies or the checkout's module graph. */
const DEPENDENCY_SHAPING_BASENAMES = new Set(['package.json', '.gitmodules', '.npmrc', 'npm-shrinkwrap.json']);
const LOCKFILE_BASENAMES = new Set(['package-lock.json']);
const GITLINK_MODE = '160000';

/** A changed lockfile line that only flips an install flag, never a version or a source. */
const LOCKFILE_FLAG_LINE = /^[+-]\s*"(dev|devOptional|optional|peer)":\s*(true|false),?\s*$/;

export interface RawDiffEntry {
  srcMode: string;
  dstMode: string;
  /** M, T, A or D (renames are disabled by the caller). */
  status: string;
  path: string;
}

/** Parse `git diff --raw --no-renames -z <a> <b>`. Returns null on any malformed record. */
export function parseRawDiffZ(out: string): RawDiffEntry[] | null {
  const parts = out.split('\0');
  if (parts.at(-1) === '') parts.pop();
  const entries: RawDiffEntry[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const meta = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(parts[i] ?? '');
    const p = parts[i + 1];
    if (!meta || !p) return null;
    entries.push({ srcMode: meta[1], dstMode: meta[2], status: meta[3], path: p });
  }
  return entries;
}

/** True when every added/removed line of a `git diff -U0` lockfile diff only flips a flag. */
export function isFlagOnlyLockfileDiff(diff: string): boolean {
  let changed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (!line.startsWith('+') && !line.startsWith('-')) continue;
    if (!LOCKFILE_FLAG_LINE.test(line)) return false;
    changed++;
  }
  return changed > 0;
}

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** Why the fork delta cannot be overlaid onto the candidate tree, or null when it can.
 *  `lockfileDiffs` maps each changed lockfile path to its `git diff -U0` text. */
export function forkDeltaOverlayRefusal(
  entries: readonly RawDiffEntry[],
  lockfileDiffs: ReadonlyMap<string, string>,
): string | null {
  if (entries.length === 0) return 'empty-delta';
  if (entries.length > FORK_BASE_OVERLAY_MAX_PATHS) return `delta-too-large:${entries.length}`;
  for (const e of entries) {
    if (!['M', 'T', 'A', 'D'].includes(e.status)) return `unsupported-status:${e.status}:${e.path}`;
    if (e.srcMode === GITLINK_MODE || e.dstMode === GITLINK_MODE) return `gitlink-change:${e.path}`;
    const name = basename(e.path);
    if (DEPENDENCY_SHAPING_BASENAMES.has(name)) return `dependency-shaping-change:${e.path}`;
    if (LOCKFILE_BASENAMES.has(name)) {
      const diff = lockfileDiffs.get(e.path);
      if (e.status !== 'M' || diff === undefined || !isFlagOnlyLockfileDiff(diff)) {
        return `lockfile-version-change:${e.path}`;
      }
    }
  }
  return null;
}

/** Counters from the affected runner's terminal `AFFECTED_TESTS_RESULT` line (the LAST one). */
export interface AffectedSuiteResult {
  status: string;
  counters: Record<string, number>;
}

export function parseAffectedTestsResult(output: string): AffectedSuiteResult | null {
  const lines = output.split('\n').filter((l) => l.includes('AFFECTED_TESTS_RESULT status='));
  const last = lines.at(-1);
  if (!last) return null;
  const status = /AFFECTED_TESTS_RESULT status=(\S+)/.exec(last)?.[1];
  if (!status) return null;
  const counters: Record<string, number> = {};
  for (const m of last.matchAll(/\b([A-Za-z]+)=(\d+)\b/g)) counters[m[1]] = Number(m[2]);
  return { status, counters };
}

/** Why the suite's own terminal result rules inheritance out, or null when it is a plain
 *  measured red. A task that timed out, could not be determined, or could not be read has
 *  failures no located file accounts for. */
export function suiteResultRefusal(result: AffectedSuiteResult | null): string | null {
  if (!result) return 'no-suite-result-line';
  if (result.status !== 'failed') return `suite-status-${result.status}`;
  for (const [key, value] of Object.entries(result.counters)) {
    if (value > 0 && /timedOut|undetermined|unreadable|crash|abort/i.test(key)) {
      return `suite-${key}=${value}`;
    }
  }
  return null;
}

const fileKey = (f: FailingFile) => `${f.workspace}::${f.file}`;

function parseTaskId(entry: string): { workspace: string; script: string } | null {
  const m = /^(\S+)\s+::\s+(\S+)$/.exec(entry.trim());
  return m ? { workspace: m[1], script: m[2] } : null;
}

export interface EntryClassification {
  inherited: string[];
  blocking: string[];
  /** Entries no located file can account for (blocking whatever the re-runs show). */
  uncovered: string[];
}

/** Classify every failure-signature entry against the set of files that inherited. */
export function classifyFailingEntries(
  failingTests: readonly string[],
  failingFiles: readonly FailingFile[],
  inheritedFiles: ReadonlySet<string>,
): EntryClassification {
  const out: EntryClassification = { inherited: [], blocking: [], uncovered: [] };
  const allInherited = (files: readonly FailingFile[]) =>
    files.length > 0 && files.every((f) => inheritedFiles.has(fileKey(f)));
  for (const entry of failingTests) {
    const byFile = failingFiles.filter((f) => f.file === entry);
    const task = parseTaskId(entry);
    const wsName = byFile.length ? null : task ? (task.script.startsWith('test') ? task.workspace : null) : entry;
    const byWorkspace = wsName ? failingFiles.filter((f) => f.workspace === wsName) : [];
    const covering = byFile.length ? byFile : byWorkspace;
    if (covering.length === 0) {
      out.uncovered.push(entry);
      out.blocking.push(entry);
    } else if (allInherited(covering)) {
      out.inherited.push(entry);
    } else {
      out.blocking.push(entry);
    }
  }
  return out;
}

export type ForkBaseFileOutcome = 'fails-at-base' | 'passes-at-base' | 'errored' | 'not-run';

export interface ForkBaseDecision {
  allInherited: boolean;
  inheritedFiles: string[];
  blockingFiles: string[];
  inheritedEntries: string[];
  blockingEntries: string[];
}

/** The verdict over measured base re-runs. Only `fails-at-base` inherits. */
export function decideForkBaseInheritance(input: {
  failingTests: readonly string[];
  failingFiles: readonly FailingFile[];
  outcomes: ReadonlyMap<string, ForkBaseFileOutcome>;
}): ForkBaseDecision {
  const inheritedFiles: string[] = [];
  const blockingFiles: string[] = [];
  for (const f of input.failingFiles) {
    (input.outcomes.get(fileKey(f)) === 'fails-at-base' ? inheritedFiles : blockingFiles).push(fileKey(f));
  }
  const entries = classifyFailingEntries(input.failingTests, input.failingFiles, new Set(inheritedFiles));
  return {
    allInherited: input.failingFiles.length > 0 && blockingFiles.length === 0 && entries.blocking.length === 0,
    inheritedFiles,
    blockingFiles,
    inheritedEntries: entries.inherited,
    blockingEntries: entries.blocking,
  };
}

export interface ForkBaseInheritanceDeps {
  /** git in the candidate checkout; never throws (a failure is a non-zero code). */
  git(args: string[]): Promise<{ code: number; stdout: string }>;
  /** The gate's own single-file isolation runner, in the same checkout. */
  runFile(f: FailingFile): Promise<IsolationResult>;
  /** ms left before the run's absolute ceiling; undefined/non-finite = unbounded. */
  remainingMs?(): number | undefined;
  log(line: string): void;
}

export interface ForkBaseInheritanceInput {
  suiteOutput: string;
  failingTests: readonly string[];
  failingFiles: readonly FailingFile[];
  base: string | null;
  candidate: string | null;
  upstreamInstall: string | null;
  upstreamRef: string | null;
  /** The suite ran in the configured checkpoint checkout (the only tree this may mutate). */
  treeIsCheckpointRoot: boolean;
}

export interface ForkBaseInheritanceOutcome {
  status: 'inherited' | 'blocking' | 'skipped';
  reason: string;
  decision?: ForkBaseDecision;
  /** Set when the delta could not be restored: the tree is NOT the candidate any more. */
  restoreFailure?: string;
  line: string;
}

function outcomeLine(status: string, reason: string, base: string | null, d?: ForkBaseDecision): string {
  return (
    `FORK_BASE_INHERITED status=${status} blocking=${d ? d.blockingEntries.length : '-'} ` +
    `blockingFiles=${d ? d.blockingFiles.length : '-'} inherited=${d ? d.inheritedFiles.length : 0} ` +
    `base=${(base ?? 'none').slice(0, 12)} reason=${reason}`
  );
}

const chunks = <T>(xs: readonly T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/** Run the whole #D-066 pass. Never throws for a fork-ineligible or refused red; returns
 *  `restoreFailure` when the checkout could not be put back to the candidate. */
export async function attemptForkBaseInheritance(
  input: ForkBaseInheritanceInput,
  deps: ForkBaseInheritanceDeps,
): Promise<ForkBaseInheritanceOutcome> {
  const { base, candidate } = input;
  const skip = (reason: string): ForkBaseInheritanceOutcome => {
    const line = outcomeLine('skipped', reason, base);
    deps.log(line);
    return { status: 'skipped', reason, line };
  };
  if (!input.upstreamInstall) return skip('no-upstream-install');
  if (!input.upstreamRef || !input.upstreamRef.startsWith(UPSTREAM_REF_PREFIX)) return skip('no-upstream-ref');
  if (!base) return skip('no-base');
  if (!candidate) return skip('no-candidate');
  if (base === candidate) return skip('base-is-candidate');
  if (!input.treeIsCheckpointRoot) return skip('tree-not-checkpoint-root');
  if (input.failingFiles.length === 0) return skip('no-located-files');
  const suiteRefusal = suiteResultRefusal(parseAffectedTestsResult(input.suiteOutput));
  if (suiteRefusal) return skip(suiteRefusal);
  // Before paying for any re-run: an entry no located file covers blocks regardless.
  const optimistic = classifyFailingEntries(
    input.failingTests,
    input.failingFiles,
    new Set(input.failingFiles.map(fileKey)),
  );
  if (optimistic.uncovered.length) return skip(`uncovered-entry:${optimistic.uncovered.join(',')}`);
  const remaining = () => {
    const ms = deps.remainingMs?.();
    return typeof ms === 'number' && Number.isFinite(ms) ? ms : Infinity;
  };
  if (remaining() < FORK_BASE_INHERITANCE_MIN_START_MS) {
    return skip(`insufficient-time-remaining:${Math.round(remaining() / 60_000)}m`);
  }

  const head = await deps.git(['rev-parse', 'HEAD']);
  if (head.code !== 0 || head.stdout.trim() !== candidate) return skip('head-is-not-candidate');
  const upstreamOk = await deps.git(['merge-base', '--is-ancestor', base, input.upstreamRef]);
  if (upstreamOk.code !== 0) return skip('base-not-upstream-content');
  const baseOk = await deps.git(['merge-base', '--is-ancestor', base, candidate]);
  if (baseOk.code !== 0) return skip('base-not-ancestor-of-candidate');
  const raw = await deps.git(['diff', '--raw', '--no-renames', '-z', base, candidate]);
  const entries = raw.code === 0 ? parseRawDiffZ(raw.stdout) : null;
  if (!entries) return skip('delta-unreadable');
  const lockfileDiffs = new Map<string, string>();
  for (const e of entries) {
    if (!LOCKFILE_BASENAMES.has(basename(e.path)) || e.status !== 'M') continue;
    const d = await deps.git(['diff', '-U0', '--no-color', base, candidate, '--', e.path]);
    if (d.code === 0) lockfileDiffs.set(e.path, d.stdout);
  }
  const refusal = forkDeltaOverlayRefusal(entries, lockfileDiffs);
  if (refusal) return skip(refusal);

  const toBase = entries.filter((e) => e.status !== 'A').map((e) => e.path);
  const added = entries.filter((e) => e.status === 'A').map((e) => e.path);
  const removedAtCandidate = entries.filter((e) => e.status === 'D').map((e) => e.path);
  const presentAtCandidate = entries.filter((e) => e.status !== 'D').map((e) => e.path);
  const outcomes = new Map<string, ForkBaseFileOutcome>();
  let overlayError: string | null = null;
  let restoreFailure: string | undefined;
  try {
    for (const group of chunks(toBase, 100)) {
      const r = await deps.git(['checkout', base, '--', ...group]);
      if (r.code !== 0) throw new Error(`checkout base failed (code ${r.code})`);
    }
    for (const group of chunks(added, 100)) {
      const r = await deps.git(['rm', '-q', '-f', '--ignore-unmatch', '--', ...group]);
      if (r.code !== 0) throw new Error(`rm added paths failed (code ${r.code})`);
    }
    deps.log(
      `fork-base inheritance: overlaid ${entries.length} delta path(s) at base ${base.slice(0, 12)}; ` +
        `re-running ${input.failingFiles.length} failing file(s) alone`,
    );
    for (const f of input.failingFiles) {
      if (remaining() < FORK_BASE_INHERITANCE_STOP_STARTING_MS) {
        outcomes.set(fileKey(f), 'not-run');
        continue;
      }
      try {
        const r = await deps.runFile(f);
        outcomes.set(fileKey(f), r.errored ? 'errored' : r.passed ? 'passes-at-base' : 'fails-at-base');
      } catch {
        outcomes.set(fileKey(f), 'errored');
      }
    }
  } catch (e) {
    overlayError = e instanceof Error ? e.message : String(e);
  } finally {
    // Restore the candidate's tracked content for exactly the delta paths, then prove it.
    try {
      for (const group of chunks(presentAtCandidate, 100)) {
        const r = await deps.git(['checkout', candidate, '--', ...group]);
        if (r.code !== 0) throw new Error(`checkout candidate failed (code ${r.code})`);
      }
      for (const group of chunks(removedAtCandidate, 100)) {
        const r = await deps.git(['rm', '-q', '-f', '--ignore-unmatch', '--', ...group]);
        if (r.code !== 0) throw new Error(`rm candidate-deleted paths failed (code ${r.code})`);
      }
      const head2 = await deps.git(['rev-parse', 'HEAD']);
      if (head2.code !== 0 || head2.stdout.trim() !== candidate) throw new Error('HEAD moved');
      for (const group of chunks(entries.map((e) => e.path), 100)) {
        const st = await deps.git(['status', '--porcelain=v1', '--untracked-files=all', '--', ...group]);
        if (st.code !== 0 || st.stdout.trim() !== '') throw new Error('delta paths still differ from the candidate');
      }
    } catch (e) {
      restoreFailure = e instanceof Error ? e.message : String(e);
    }
  }
  if (restoreFailure) {
    const line = outcomeLine('skipped', `restore-failed:${restoreFailure}`, base);
    deps.log(line);
    return { status: 'skipped', reason: `restore-failed:${restoreFailure}`, restoreFailure, line };
  }
  if (overlayError) return skip(`overlay-failed:${overlayError}`);
  const decision = decideForkBaseInheritance({
    failingTests: input.failingTests,
    failingFiles: input.failingFiles,
    outcomes,
  });
  const notRun = [...outcomes.values()].filter((o) => o === 'not-run').length;
  const errored = [...outcomes.values()].filter((o) => o === 'errored').length;
  const reason = decision.allInherited
    ? 'all-fail-at-base'
    : `passes-at-base=${[...outcomes.values()].filter((o) => o === 'passes-at-base').length},errored=${errored},not-run=${notRun}`;
  const status = decision.allInherited ? 'inherited' : 'blocking';
  const line = outcomeLine(status, reason, base, decision);
  deps.log(line);
  return { status, reason, decision, line };
}
