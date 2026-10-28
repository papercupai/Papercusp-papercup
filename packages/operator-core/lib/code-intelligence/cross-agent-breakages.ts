/**
 * Cross-agent breakage reader — the recall input of the R-12 shadow window
 * (code-intel-delivery-and-outcomes-2026-10-26 P-012, D-014, D-037).
 *
 * A breakage is a gate red that one agent caused in a file another agent holds:
 *
 *  1. Population: the first CI red after a CI green for one test file T
 *     (source='ci', worktree_dirty=false, status 'fail'; 'error' is excluded as
 *     mass-collection/infra noise). CI rows carry workspace_id NULL, so the read
 *     accepts the workspace OR NULL.
 *  2. Editor A: an edit_attribution_ledger edit to a file Y with ts in
 *     (green.started_at, red.started_at] and ts >= red.finished_at - 24h.
 *  3. Reachability: Y is in the static relative-import closure of T
 *     (search/import-graph.ts), Y != T and Y != subject(T). The relation is the
 *     import graph, independent of the derivation's symbol-caller measurement, so
 *     recall is not computed from the same evidence that made the edges.
 *  4. Holder B: an agent with an edit to T or subject(T) in
 *     [red.finished_at - 24h, red.finished_at]; A != B by ownerId.
 *  5. Any read error, and any cap that would truncate the population, fails
 *     closed to null: recall then stays reader-unavailable.
 *
 * Known limits (D-037): package-specifier (`@papercusp/*`) imports are not traversed,
 * so reachability is under-reported; files are read from the tree at rescore time,
 * not at the red's commit; lint:tsc and lint:behavioural-strands reds have no
 * per-file ledger and are not counted.
 *
 * This module is import-light: the import-graph walker (which loads `typescript`)
 * is imported lazily inside the reader.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import type { CrossAgentBreakage } from './coupling-shadow-window';

const HOUR_MS = 3_600_000;
export const BREAKAGE_WINDOW_MS = 24 * HOUR_MS;
export interface BreakageReaderLimits { maxReds: number; maxEdits: number; maxFiles: number; yieldEvery: number }
export const BREAKAGE_READER_LIMITS: Readonly<BreakageReaderLimits> = Object.freeze({
  /** Red transitions per read; reaching it fails closed (the population would be cut). */
  maxReds: 5000,
  /** Ledger edits per read; reaching it fails closed. */
  maxEdits: 250_000,
  /** Distinct files the import walk may read across all closures; reaching it fails closed. */
  maxFiles: 20_000,
  /** Files walked between event-loop yields. */
  yieldEvery: 200,
});

/** The first CI red after a CI green for one test file. Times are epoch ms. */
export interface GateRedTransition {
  filePath: string;
  greenStartedAt: number;
  redStartedAt: number;
  redFinishedAt: number;
}

/** One ledger edit, with the file as an absolute path (repo_root + file). */
export interface LedgerEdit { file: string; agentId: string; ts: number }

/** A breakage with the evidence that produced it. */
export interface CrossAgentBreakageEvidence extends CrossAgentBreakage {
  testFile: string;
  editedFiles: string[];
}

const TEST_SUFFIX = /\.(?:integration\.test|e2e\.test|test|spec)\.(?:ts|tsx|mts)$/;

/** The source files a test file covers: `x.test.ts` → `x.ts` / `x.tsx`. Empty for a non-test path. */
export function subjectsOf(testFile: string): string[] {
  if (!TEST_SUFFIX.test(testFile)) return [];
  const stem = testFile.replace(TEST_SUFFIX, '');
  return [`${stem}.ts`, `${stem}.tsx`];
}

/** Index of the first element with ts >= t in a ts-sorted array. */
function lowerBound(edits: readonly LedgerEdit[], t: number): number {
  let lo = 0;
  let hi = edits.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (edits[mid].ts < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * Pure: reds × edits × import reachability × holders → breakages.
 *
 * `testAbs` maps a red's file_path to the absolute path its closure is keyed by
 * (absent when the path did not resolve to exactly one file). `closures` maps that
 * absolute path to its relative-import closure (absolute paths, entry excluded).
 * One breakage is emitted per red and distinct (editor, holder) pair.
 */
export function deriveCrossAgentBreakages(input: {
  reds: readonly GateRedTransition[];
  edits: readonly LedgerEdit[];
  testAbs: ReadonlyMap<string, string>;
  closures: ReadonlyMap<string, ReadonlySet<string>>;
  windowMs?: number;
}): CrossAgentBreakageEvidence[] {
  const windowMs = input.windowMs ?? BREAKAGE_WINDOW_MS;
  const edits = [...input.edits].sort((x, y) => x.ts - y.ts);
  const out: CrossAgentBreakageEvidence[] = [];
  for (const red of input.reds) {
    const test = input.testAbs.get(red.filePath);
    const closure = test ? input.closures.get(test) : undefined;
    if (!test || !closure) continue;
    const subjects = new Set(subjectsOf(test));
    const floor = red.redFinishedAt - windowMs;

    const holders = new Set<string>();
    for (let i = lowerBound(edits, floor); i < edits.length && edits[i].ts <= red.redFinishedAt; i += 1) {
      const e = edits[i];
      if (e.file === test || subjects.has(e.file)) holders.add(e.agentId);
    }
    if (!holders.size) continue;

    const editors = new Map<string, Set<string>>();
    for (let i = lowerBound(edits, Math.max(floor, red.greenStartedAt)); i < edits.length && edits[i].ts <= red.redStartedAt; i += 1) {
      const e = edits[i];
      // (green.started_at, red.started_at]: an edit exactly at the green's start ran in the green.
      if (e.ts <= red.greenStartedAt || e.file === test || subjects.has(e.file) || !closure.has(e.file)) continue;
      const files = editors.get(e.agentId) ?? new Set<string>();
      files.add(e.file);
      editors.set(e.agentId, files);
    }
    for (const [editor, files] of editors) {
      for (const holder of holders) {
        if (holder === editor) continue;
        out.push({ ts: red.redFinishedAt, editorOwnerId: editor, holderOwnerId: holder, testFile: red.filePath, editedFiles: [...files].sort() });
      }
    }
  }
  return out.sort((x, y) => x.ts - y.ts);
}

export interface ImportWalkDeps {
  /** Runtime import specifiers of one file (import-graph.ts runtimeSpecifiers). */
  specifiers: (file: string) => string[];
  /** Resolve a relative specifier to a file, or null (import-graph.ts resolveRelative). */
  resolve: (fromFile: string, specifier: string) => string | null;
}

export interface ImportClosures {
  /** Null when the walk hit `maxFiles`: the closure would be cut, so it is unmeasured. */
  closures: Map<string, Set<string>> | null;
  filesRead: number;
  unreadable: number;
}

/**
 * Async, bounded relative-import closures for several entries. The resolved edges of
 * each file are memoized across entries, so a file is read once per call however many
 * closures contain it, and the walk yields to the event loop every `yieldEvery` files so
 * a rescore never blocks it. An unreadable file (deleted since the red) has no edges.
 */
export async function importClosures(
  entries: readonly string[], deps: ImportWalkDeps,
  opts: { maxFiles?: number; yieldEvery?: number } = {},
): Promise<ImportClosures> {
  const maxFiles = opts.maxFiles ?? BREAKAGE_READER_LIMITS.maxFiles;
  const yieldEvery = opts.yieldEvery ?? BREAKAGE_READER_LIMITS.yieldEvery;
  const edgesOf = new Map<string, string[]>();
  let unreadable = 0;
  let sinceYield = 0;
  const neighbours = async (file: string): Promise<string[] | null> => {
    const known = edgesOf.get(file);
    if (known) return known;
    if (edgesOf.size >= maxFiles) return null;
    let specs: string[] = [];
    try {
      specs = deps.specifiers(file);
    } catch {
      unreadable += 1;
    }
    const next = specs.filter(s => s.startsWith('.')).map(s => deps.resolve(file, s)).filter((p): p is string => !!p);
    edgesOf.set(file, next);
    if (++sinceYield >= yieldEvery) {
      sinceYield = 0;
      await new Promise<void>(r => setImmediate(r));
    }
    return next;
  };
  const closures = new Map<string, Set<string>>();
  for (const entry of new Set(entries)) {
    const seen = new Set<string>([entry]);
    const queue = [entry];
    while (queue.length) {
      const next = await neighbours(queue.pop()!);
      if (!next) return { closures: null, filesRead: edgesOf.size, unreadable };
      for (const n of next) if (!seen.has(n)) { seen.add(n); queue.push(n); }
    }
    seen.delete(entry);
    closures.set(entry, seen);
  }
  return { closures, filesRead: edgesOf.size, unreadable };
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The first CI red after a CI green per test file, with the red finishing in
 * [since, until]. Shared with the push-leg per-file red reader (WI-6554700010030568).
 */
export async function readGateRedTransitions(
  sql: Sql, workspaceId: string, since: number, until: number, limit = BREAKAGE_READER_LIMITS.maxReds,
): Promise<GateRedTransition[]> {
  const rows = await sql<{ file_path: string; green_started: string; red_started: string; red_finished: string }[]>`
    SELECT f.file_path,
           (extract(epoch FROM p.started_at) * 1000)::bigint::text AS green_started,
           (extract(epoch FROM f.started_at) * 1000)::bigint::text AS red_started,
           (extract(epoch FROM f.finished_at) * 1000)::bigint::text AS red_finished
      FROM harness_shared.test_runs f
      CROSS JOIN LATERAL (
        SELECT t.status, t.started_at FROM harness_shared.test_runs t
         WHERE t.file_path = f.file_path AND t.source = 'ci' AND t.worktree_dirty = false
           AND t.status IN ('pass', 'fail') AND t.id <> f.id AND t.finished_at < f.finished_at
           AND (t.workspace_id = ${workspaceId} OR t.workspace_id IS NULL)
         ORDER BY t.finished_at DESC LIMIT 1) p
     WHERE f.source = 'ci' AND f.status = 'fail' AND f.worktree_dirty = false
       AND (f.workspace_id = ${workspaceId} OR f.workspace_id IS NULL)
       AND f.finished_at >= ${iso(since)}::timestamptz AND f.finished_at <= ${iso(until)}::timestamptz
       AND p.status = 'pass'
     ORDER BY f.finished_at
     LIMIT ${limit}`;
  return rows.map(r => ({
    filePath: r.file_path, greenStartedAt: Number(r.green_started),
    redStartedAt: Number(r.red_started), redFinishedAt: Number(r.red_finished),
  }));
}

export interface CrossAgentBreakageRead {
  /** Null when unmeasured: a read error or a cap that would cut the population. */
  breakages: CrossAgentBreakageEvidence[] | null;
  reds: number;
  /** Reds whose file resolved to no file, or to more than one repo, at rescore time. */
  unresolvedReds: number;
  filesRead: number;
  reason: string;
}

/** Resolve each red's file_path against the ledger repo roots; keep it only when exactly one root has it. */
export function resolveTestFiles(
  reds: readonly GateRedTransition[], roots: readonly string[], exists: (p: string) => boolean = existsSync,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const filePath of new Set(reds.map(r => r.filePath))) {
    const hits = roots.map(root => join(root, filePath)).filter(p => exists(p));
    if (hits.length === 1) out.set(filePath, hits[0]);
  }
  return out;
}

/**
 * Read the breakages whose red finished in [start, now]. Fails closed to
 * `breakages: null` on any error or truncating cap; never throws.
 */
export async function readCrossAgentBreakages(
  sql: Sql, workspaceId: string, start: number, now: number,
  opts: { walk?: ImportWalkDeps; exists?: (p: string) => boolean; limits?: Partial<BreakageReaderLimits> } = {},
): Promise<CrossAgentBreakageRead> {
  const L = { ...BREAKAGE_READER_LIMITS, ...opts.limits };
  const unmeasured = (reason: string, reds = 0, filesRead = 0): CrossAgentBreakageRead =>
    ({ breakages: null, reds, unresolvedReds: 0, filesRead, reason });
  try {
    const reds = await readGateRedTransitions(sql, workspaceId, start, now, L.maxReds);
    if (reds.length >= L.maxReds) return unmeasured(`red transitions reached the ${L.maxReds} cap`, reds.length);
    if (!reds.length) return { breakages: [], reds: 0, unresolvedReds: 0, filesRead: 0, reason: 'no CI red transitions in the window' };
    const lo = Math.min(...reds.map(r => r.redFinishedAt)) - BREAKAGE_WINDOW_MS;
    const hi = Math.max(...reds.map(r => r.redFinishedAt));
    const rows = await sql<{ repo_root: string; file: string; agent_id: string; ts: string }[]>`
      SELECT repo_root, file, agent_id, (extract(epoch FROM ts) * 1000)::bigint::text AS ts
        FROM harness_shared.edit_attribution_ledger
       WHERE workspace_id = ${workspaceId}
         AND ts >= ${iso(lo)}::timestamptz AND ts <= ${iso(hi)}::timestamptz
         AND agent_id IS NOT NULL AND repo_root IS NOT NULL AND file IS NOT NULL
       ORDER BY ts
       LIMIT ${L.maxEdits}`;
    if (rows.length >= L.maxEdits) return unmeasured(`ledger edits reached the ${L.maxEdits} cap`, reds.length);
    const edits: LedgerEdit[] = rows.map(r => ({ file: join(r.repo_root, r.file), agentId: r.agent_id, ts: Number(r.ts) }));
    const roots = [...new Set(rows.map(r => r.repo_root))];
    const testAbs = resolveTestFiles(reds, roots, opts.exists);
    let walk: ImportWalkDeps;
    if (opts.walk) walk = opts.walk;
    else {
      const graph = await import('../search/import-graph');
      walk = { specifiers: graph.runtimeSpecifiers, resolve: graph.resolveRelative };
    }
    const walked = await importClosures([...testAbs.values()], walk, { maxFiles: L.maxFiles, yieldEvery: L.yieldEvery });
    if (!walked.closures) return unmeasured(`import walk reached the ${L.maxFiles}-file cap`, reds.length, walked.filesRead);
    const unresolvedReds = reds.filter(r => !testAbs.has(r.filePath)).length;
    const breakages = deriveCrossAgentBreakages({ reds, edits, testAbs, closures: walked.closures });
    return {
      breakages, reds: reds.length, unresolvedReds, filesRead: walked.filesRead,
      reason: `${breakages.length} breakage(s) from ${reds.length} red transition(s), ${unresolvedReds} unresolved, ${walked.filesRead} file(s) walked`,
    };
  } catch (err) {
    return unmeasured(`breakage read failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
  }
}
