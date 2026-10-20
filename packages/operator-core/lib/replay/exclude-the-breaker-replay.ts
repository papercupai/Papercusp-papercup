/**
 * Exclude-the-breaker replay — the P-020 design spike of plan green-main-cycle-time-2026-10-08
 * (decision recorded there as the spike's outcome).
 *
 * The question: when a frozen candidate C (cut from staging after the last green G) goes red,
 * could the gate instead promote "C minus the breakers" — every changed path a first-round red
 * test can reach — and leave the breakers on staging for fix-forward? This module answers it
 * from RECORDED queue data only: no builds, no test runs, no gate state. It is pure; the
 * collection of its inputs (git diffs, the test-run ledger, `test_executed_sources`,
 * `edit_attribution_ledger`) lives in the caller.
 *
 * ⛔ Nothing in the gate imports this module (pinned by its test): the spike evaluates an
 * option, it does not change promotion behaviour.
 *
 * Model (stated, so a reader can falsify it):
 *  - A red test's REACH is the test file plus every module it executed
 *    (`test_executed_sources`). Its SUSPECTS are reach ∩ delta(G..C). A red with no suspect is
 *    UNATTRIBUTABLE: nothing that changed is on its executed path (a tree-scanning guard, a
 *    data file read at runtime, or an environmental red).
 *  - EXCLUDING a path reverts it to its blob at G. A KEPT changed file that imports an
 *    excluded file that did not exist at G no longer builds, so exclusion must widen to it —
 *    transitively (the CLOSURE). Symbol-level coupling (a kept file using a new export of an
 *    excluded MODIFIED file) is invisible to an import scan, so the closure is a LOWER bound.
 *  - Projected time-to-green = first red verdict + exclusion build + one full round, and is
 *    valid only when every first-round red is attributable and the exclusion needs no
 *    widening.
 */
import { posix } from 'node:path';
import type { EditAttributionRow } from '../release/hunk-exact-admission';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

export interface DeltaChange {
  path: string;
  /** git name-status letter: A(dded) | M(odified) | D(eleted) | … */
  kind: string;
  hunks: number;
}

export interface ReplayEdit extends EditAttributionRow {
  workItem?: string | null;
}

export interface RedFileObservation {
  file: string;
  /** Modules the test executed (repo-relative); null when the ledger has no row (UNMAPPED). */
  executed: readonly string[] | null;
  /** Did a later round see it pass? */
  fixed: boolean;
  /** Paths admitted between the last red round and the fixing round (the actual fix-forward). */
  fixPaths: readonly string[];
}

export type QueueOutcome =
  | { outcome: 'green'; greenAtMs: number }
  | { outcome: 'never-green'; retiredAtMs: number | null };

export interface ReplayQueueInput {
  queue: string;
  cutAtMs: number;
  /** Edits after this instant (the previous green's cut) and at or before cutAtMs are the window's. */
  windowStartMs: number;
  /** When the first round's red verdict was known. */
  firstRedKnownAtMs: number;
  firstRoundRed: readonly string[];
  delta: ReadonlyMap<string, DeltaChange>;
  redFiles: readonly RedFileObservation[];
  edits: readonly ReplayEdit[];
  /** For each KEPT-candidate changed code file: its import specifiers resolved to repo paths. */
  resolvedImports: ReadonlyMap<string, readonly string[]>;
  actual: QueueOutcome;
}

export interface ReplayModel {
  exclusionBuildMin: number;
  fullRoundMin: number;
}

export interface ExclusionScope {
  excludedPaths: number;
  excludedHunks: number;
  excludedAdded: number;
  agents: number;
  topAgents: Array<[string, number]>;
  workItems: number;
  pathsWithNoLedgerEdit: number;
  /** Kept changed files importing an excluded file that is new in the window. */
  keptImportersOfExcludedAdded: number;
  coupledSample: string[];
  /** Exclusion widened transitively until no kept file imports an excluded added file. */
  closure: { excludedPaths: number; addedByClosure: number; agents: number; rounds: number };
}

export interface QueueReplay {
  queue: string;
  deltaPaths: number;
  deltaHunks: number;
  firstRoundRed: number;
  redFilesEver: number;
  redFilesNeverFixed: number;
  firstRound: {
    mapped: number;
    attributable: number;
    unattributable: Array<{ file: string; mapped: boolean }>;
    exclusion: ExclusionScope;
  };
  allReds: { attributable: number; of: number; exclusion: ExclusionScope };
  validation: {
    fixedWithAdmittedFix: number;
    fixTouchedASuspect: number;
    fixTouchedReachButNotSuspect: number;
    fixOutsideReach: number;
    fixOutsideReachSample: Array<{ file: string; mapped: boolean; fix: string[] }>;
  };
  actual: { outcome: 'green'; ttgHours: number } | { outcome: 'never-green'; heldHours: number | null };
  projection: {
    projectedTtgHours: number;
    preconditions: { allFirstRoundAttributable: boolean; noCouplingWidening: boolean };
    preconditionsMet: boolean;
    /** Hours saved versus the actual outcome (null when the queue never went green and was not retired). */
    hoursSavedVsActual: number | null;
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** reach ∩ delta: the changed paths a red test actually executed (or is). */
export function suspectsOf(red: RedFileObservation, delta: ReadonlyMap<string, DeltaChange>): string[] {
  const reach = new Set<string>([red.file, ...(red.executed ?? [])]);
  return [...reach].filter((p) => delta.has(p));
}

function isAdded(delta: ReadonlyMap<string, DeltaChange>, p: string): boolean {
  return delta.get(p)?.kind === 'A';
}

/** Kept changed files (not excluded, not deleted) that import an excluded ADDED file. */
export function coupledImporters(
  excluded: ReadonlySet<string>,
  delta: ReadonlyMap<string, DeltaChange>,
  resolvedImports: ReadonlyMap<string, readonly string[]>,
): string[] {
  const out: string[] = [];
  for (const [file, imports] of resolvedImports) {
    if (excluded.has(file) || delta.get(file)?.kind === 'D' || !delta.has(file)) continue;
    if (imports.some((i) => excluded.has(i) && isAdded(delta, i))) out.push(file);
  }
  return out.sort();
}

/** Widen an exclusion until no kept changed file imports an excluded added file. */
export function couplingClosure(
  seed: ReadonlySet<string>,
  delta: ReadonlyMap<string, DeltaChange>,
  resolvedImports: ReadonlyMap<string, readonly string[]>,
): { excluded: Set<string>; rounds: number } {
  const excluded = new Set(seed);
  let rounds = 0;
  for (;;) {
    const more = coupledImporters(excluded, delta, resolvedImports);
    if (more.length === 0) return { excluded, rounds };
    rounds += 1;
    for (const f of more) excluded.add(f);
  }
}

function agentsTouching(paths: ReadonlySet<string>, input: ReplayQueueInput) {
  const agents = new Map<string, number>();
  const workItems = new Set<string>();
  const ledgered = new Set<string>();
  for (const ed of input.edits) {
    if (!paths.has(ed.path) || ed.tsMs <= input.windowStartMs || ed.tsMs > input.cutAtMs) continue;
    agents.set(ed.agent, (agents.get(ed.agent) ?? 0) + 1);
    ledgered.add(ed.path);
    if (ed.workItem) workItems.add(ed.workItem);
  }
  return { agents, workItems, ledgered };
}

export function exclusionScope(rows: readonly RedFileObservation[], input: ReplayQueueInput): ExclusionScope {
  const E = new Set(rows.flatMap((r) => suspectsOf(r, input.delta)));
  const { agents, workItems, ledgered } = agentsTouching(E, input);
  const coupled = coupledImporters(E, input.delta, input.resolvedImports);
  const closure = couplingClosure(E, input.delta, input.resolvedImports);
  const closureAgents = agentsTouching(closure.excluded, input).agents;
  return {
    excludedPaths: E.size,
    excludedHunks: [...E].reduce((n, p) => n + (input.delta.get(p)?.hunks ?? 0), 0),
    excludedAdded: [...E].filter((p) => isAdded(input.delta, p)).length,
    agents: agents.size,
    topAgents: [...agents.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5),
    workItems: workItems.size,
    pathsWithNoLedgerEdit: [...E].filter((p) => !ledgered.has(p)).length,
    keptImportersOfExcludedAdded: coupled.length,
    coupledSample: coupled.slice(0, 5),
    closure: {
      excludedPaths: closure.excluded.size,
      addedByClosure: closure.excluded.size - E.size,
      agents: closureAgents.size,
      rounds: closure.rounds,
    },
  };
}

/** Replay one queue: attribution, exclusion scope, fix-locality validation, projection. */
export function replayQueue(input: ReplayQueueInput, model: ReplayModel): QueueReplay {
  const firstRound = new Set(input.firstRoundRed);
  const r0 = input.redFiles.filter((r) => firstRound.has(r.file));
  const attributable = (xs: readonly RedFileObservation[]) => xs.filter((x) => suspectsOf(x, input.delta).length > 0);
  const r0Attributable = attributable(r0);
  const r0Scope = exclusionScope(r0Attributable, input);

  const fixedRows = input.redFiles.filter((r) => r.fixed && r.fixPaths.length > 0);
  const touches = (r: RedFileObservation) => {
    const suspects = new Set(suspectsOf(r, input.delta));
    const reach = new Set([r.file, ...(r.executed ?? [])]);
    return {
      suspect: r.fixPaths.some((p) => suspects.has(p)),
      reach: r.fixPaths.some((p) => reach.has(p)),
    };
  };
  const outside = fixedRows.filter((r) => !touches(r).reach);

  const projectedTtgHours =
    (input.firstRedKnownAtMs - input.cutAtMs + (model.exclusionBuildMin + model.fullRoundMin) * MINUTE_MS) / HOUR_MS;
  const allFirstRoundAttributable = r0Attributable.length === r0.length;
  const noCouplingWidening = r0Scope.keptImportersOfExcludedAdded === 0;

  const actual: QueueReplay['actual'] =
    input.actual.outcome === 'green'
      ? { outcome: 'green', ttgHours: round1((input.actual.greenAtMs - input.cutAtMs) / HOUR_MS) }
      : {
          outcome: 'never-green',
          heldHours: input.actual.retiredAtMs === null ? null : round1((input.actual.retiredAtMs - input.cutAtMs) / HOUR_MS),
        };
  const actualHours = actual.outcome === 'green' ? actual.ttgHours : actual.heldHours;

  return {
    queue: input.queue,
    deltaPaths: input.delta.size,
    deltaHunks: [...input.delta.values()].reduce((n, c) => n + c.hunks, 0),
    firstRoundRed: r0.length,
    redFilesEver: input.redFiles.length,
    redFilesNeverFixed: input.redFiles.filter((r) => !r.fixed).length,
    firstRound: {
      mapped: r0.filter((r) => r.executed !== null).length,
      attributable: r0Attributable.length,
      unattributable: r0
        .filter((r) => suspectsOf(r, input.delta).length === 0)
        .map((r) => ({ file: r.file, mapped: r.executed !== null })),
      exclusion: r0Scope,
    },
    allReds: {
      attributable: attributable(input.redFiles).length,
      of: input.redFiles.length,
      exclusion: exclusionScope(attributable(input.redFiles), input),
    },
    validation: {
      fixedWithAdmittedFix: fixedRows.length,
      fixTouchedASuspect: fixedRows.filter((r) => touches(r).suspect).length,
      fixTouchedReachButNotSuspect: fixedRows.filter((r) => !touches(r).suspect && touches(r).reach).length,
      fixOutsideReach: outside.length,
      fixOutsideReachSample: outside
        .slice(0, 8)
        .map((r) => ({ file: r.file, mapped: r.executed !== null, fix: [...new Set(r.fixPaths)].slice(0, 3) })),
    },
    actual,
    projection: {
      projectedTtgHours: round1(projectedTtgHours),
      preconditions: { allFirstRoundAttributable, noCouplingWidening },
      preconditionsMet: allFirstRoundAttributable && noCouplingWidening,
      hoursSavedVsActual: actualHours === null ? null : round1(actualHours - projectedTtgHours),
    },
  };
}

const CODE_EXT = /\.(m?[jt]sx?|cjs)$/;
const SPECIFIER_PATTERNS = [
  /\bfrom\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /^\s*import\s+['"]([^'"\n]+)['"]/gm,
  /\bvi\.mock\s*\(\s*['"]([^'"\n]+)['"]/g,
];

export function isCodePath(p: string): boolean {
  return CODE_EXT.test(p);
}

/** Every module specifier a source file names (static, dynamic, require, side-effect, vi.mock). */
export function importSpecifiers(source: string): string[] {
  const out = new Set<string>();
  for (const re of SPECIFIER_PATTERNS) for (const m of source.matchAll(re)) out.add(m[1]);
  return [...out];
}

const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.mjs'];

/**
 * Resolve a specifier written in `fromPath` to a repo-relative path, or null when it names
 * something outside the repo (a node builtin, an npm dependency) or nothing that exists.
 * Workspace packages resolve by their package name → directory (longest name prefix wins).
 */
export function resolveSpecifier(
  fromPath: string,
  specifier: string,
  exists: (repoPath: string) => boolean,
  workspaceDirs: ReadonlyMap<string, string>,
): string | null {
  let base: string | null = null;
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    base = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  } else {
    let best: [string, string] | null = null;
    for (const [name, dir] of workspaceDirs) {
      if ((specifier === name || specifier.startsWith(`${name}/`)) && (!best || name.length > best[0].length)) best = [name, dir];
    }
    if (!best) return null;
    const rest = specifier.slice(best[0].length).replace(/^\//, '');
    base = rest ? posix.join(best[1], rest) : best[1];
  }
  if (base.startsWith('../')) return null;
  const stems = [base];
  const js = /\.(m?)js$/.exec(base);
  if (js) stems.push(base.slice(0, -js[0].length)); // ESM '.js' written for a '.ts' source
  for (const stem of stems) for (const suffix of RESOLVE_SUFFIXES) if (exists(stem + suffix)) return stem + suffix;
  return null;
}

export function resolveImports(
  fromPath: string,
  source: string,
  exists: (repoPath: string) => boolean,
  workspaceDirs: ReadonlyMap<string, string>,
): string[] {
  const out = new Set<string>();
  for (const s of importSpecifiers(source)) {
    const r = resolveSpecifier(fromPath, s, exists, workspaceDirs);
    if (r) out.add(r);
  }
  return [...out].sort();
}
