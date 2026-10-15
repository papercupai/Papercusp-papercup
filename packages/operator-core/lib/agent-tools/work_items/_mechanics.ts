/**
 * P-009 / R-8 (plan derived-status-not-hand-written-2026-10-12, decision D-004):
 * a held work item's MECHANICAL section, derived from the ledgers at READ time.
 *
 * The facts are the holder and claim time, the files the holder wrote since the
 * claim, the latest result for each related test file, and the open external
 * blockers. Each one already sits in a ledger:
 *
 *   holder, claim time  -> the work-item row (assignee, takenAt)
 *   files written       -> harness_shared.agent_activity: "✎" rows carry
 *                          detail.file; "▶" rows carry detail.command, parsed by
 *                          the same extractor the P-015 turn-end sweep uses
 *   test results        -> harness_shared.test_runs, excluding mutation probes
 *   open blockers       -> work_items.external_blockers_projection, status 'active'
 *
 * Nothing here is stored. A checkpoint used to carry these facts as text (the
 * agent's own prose, or the `⟦auto-checkpoint mechanical⟧` block appended at
 * turn end), and text goes stale the moment it is written. D-004 measured that
 * block on 55 of 200 recent checkpoints. Because this section is recomputed on
 * every read, it always matches the ledgers it came from.
 *
 * Attribution limit, stated on the output: test_runs has no owner column. A test
 * run is tied to this item only by its FILE PATH (a test file the holder wrote,
 * or a conventional sibling of a written source) and by the claim window. It is
 * not proof the holder ran it.
 */
import { getOrgPg } from '@papercusp/db-org';
import { extractFileWritePaths, type FileWriteLedgerRow } from '../../turn-end-tracking';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { resolveHarnessRepoRoot } from '../../harness/docs/harness-repo';

/** Upper bound on activity rows read per item: one claim window rarely exceeds it. */
export const MECHANICS_ACTIVITY_LIMIT = 500;
/** Upper bound on files listed; a larger set is reported as truncated, never silently cut. */
export const MECHANICS_FILES_CAP = 40;

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const SIBLING_TEST_SUFFIXES = ['.test.ts', '.test.tsx', '.integration.test.ts', '.spec.ts'];

export interface MechanicsWorkItem {
  id: string;
  harness?: string | null;
  assignee?: string | null;
  takenAt?: string | null;
}

export interface MechanicsTestRunRow {
  file_path: string;
  status: string;
  finished_at: string | null;
  source: string | null;
  worktree_dirty: boolean | null;
  commit_sha: string | null;
  passed: number | null;
  failed: number | null;
}

export interface MechanicsBlockerRow {
  kind?: string | null;
  ref?: string | null;
  status?: string | null;
  summary?: string | null;
}

export interface MechanicsTestResult {
  file: string;
  status: string;
  at: string | null;
  passed: number | null;
  failed: number | null;
  dirtyTree: boolean | null;
  commitSha: string | null;
}

export interface WorkItemMechanics {
  /** Always 'read-time': this object is computed per read and never persisted. */
  derived: 'read-time';
  derivedAt: string;
  holder: { ownerId: string; claimedAt: string };
  filesWritten: { paths: string[]; total: number; truncated: boolean; outsideRepo: number };
  tests: {
    attribution: 'path-and-claim-window';
    latest: MechanicsTestResult[];
    /** 'none' = no related run in the window, which is not the same as passing. */
    verdict: 'none' | 'all-pass' | 'all-skipped' | 'failing';
  };
  openBlockers: Array<{ kind: string | null; ref: string | null; summary: string | null }>;
  sources: string[];
}

/** Repo-relative form of an absolute path under one of `repoRoots`; null when outside all of them. */
export function toRepoRelative(path: string, repoRoots: readonly string[]): string | null {
  const p = path.trim();
  if (!p) return null;
  if (!p.startsWith('/')) return p.replace(/^\.\//, '');
  for (const raw of repoRoots) {
    const root = raw.replace(/\/+$/, '');
    if (root && p.startsWith(`${root}/`)) return p.slice(root.length + 1) || null;
  }
  return null;
}

/** Scratch and runtime state are not deliverables. */
function isWorkProduct(rel: string): boolean {
  return !rel.startsWith('.papercusp/') && !rel.startsWith('node_modules/') && !rel.includes('/node_modules/');
}

/**
 * Test files whose runs count for these written paths: every written test file,
 * plus each written source's conventional siblings (`x.ts` -> `x.test.ts`, …).
 * The candidates are EXACT paths so the lookup can use the
 * test_runs(file_path, finished_at DESC) index instead of a LIKE scan.
 */
export function relatedTestFiles(written: readonly string[]): string[] {
  const out = new Set<string>();
  for (const rel of written) {
    if (TEST_FILE.test(rel)) {
      out.add(rel);
      continue;
    }
    if (!SOURCE_FILE.test(rel)) continue;
    const stem = rel.replace(SOURCE_FILE, '');
    for (const suffix of SIBLING_TEST_SUFFIXES) out.add(`${stem}${suffix}`);
  }
  return [...out];
}

/** The latest non-probe run per file, so a newer result always replaces an older one. */
export function latestRunPerFile(rows: readonly MechanicsTestRunRow[]): MechanicsTestResult[] {
  const best = new Map<string, MechanicsTestRunRow>();
  for (const row of rows) {
    if (row.source === 'mutation-probe') continue;
    const prev = best.get(row.file_path);
    const at = row.finished_at ? Date.parse(row.finished_at) : Number.NEGATIVE_INFINITY;
    const prevAt = prev?.finished_at ? Date.parse(prev.finished_at) : Number.NEGATIVE_INFINITY;
    if (!prev || at > prevAt) best.set(row.file_path, row);
  }
  return [...best.values()]
    .sort((a, b) => a.file_path.localeCompare(b.file_path))
    .map((r) => ({
      file: r.file_path,
      status: r.status,
      at: r.finished_at,
      passed: r.passed,
      failed: r.failed,
      dirtyTree: r.worktree_dirty,
      commitSha: r.commit_sha,
    }));
}

export function testVerdict(latest: readonly MechanicsTestResult[]): WorkItemMechanics['tests']['verdict'] {
  if (latest.length === 0) return 'none';
  if (!latest.every((t) => t.status === 'pass' || t.status === 'skip')) return 'failing';
  // Blind review #14 G-3: a set in which nothing passed is not a passing set. When every
  // related run was skipped, no test executed, so the verdict says so instead of 'all-pass'.
  return latest.some((t) => t.status === 'pass') ? 'all-pass' : 'all-skipped';
}

export interface DeriveMechanicsInput {
  workItem: MechanicsWorkItem;
  writeRows: readonly FileWriteLedgerRow[];
  repoRoots: readonly string[];
  testRuns: readonly MechanicsTestRunRow[];
  blockers: readonly MechanicsBlockerRow[] | null | undefined;
  now?: Date;
}

/** Pure: ledger rows in, mechanical section out. Null when the item has no live claim window. */
export function deriveWorkItemMechanics(input: DeriveMechanicsInput): WorkItemMechanics | null {
  const ownerId = input.workItem.assignee?.trim();
  const claimedAt = input.workItem.takenAt?.trim();
  if (!ownerId || !claimedAt) return null;

  const written: string[] = [];
  let outsideRepo = 0;
  for (const p of extractFileWritePaths(input.writeRows)) {
    const rel = toRepoRelative(p, input.repoRoots);
    if (rel === null) {
      outsideRepo++;
      continue;
    }
    if (isWorkProduct(rel) && !written.includes(rel)) written.push(rel);
  }
  written.sort();

  const related = new Set(relatedTestFiles(written));
  const latest = latestRunPerFile(input.testRuns.filter((r) => related.has(r.file_path)));

  const openBlockers = (input.blockers ?? [])
    .filter((b) => (b.status ?? 'active') === 'active')
    .map((b) => ({ kind: b.kind ?? null, ref: b.ref ?? null, summary: b.summary ?? null }));

  return {
    derived: 'read-time',
    derivedAt: (input.now ?? new Date()).toISOString(),
    holder: { ownerId, claimedAt },
    filesWritten: {
      paths: written.slice(0, MECHANICS_FILES_CAP),
      total: written.length,
      truncated: written.length > MECHANICS_FILES_CAP,
      outsideRepo,
    },
    tests: { attribution: 'path-and-claim-window', latest, verdict: testVerdict(latest) },
    openBlockers,
    sources: [
      'work_items.assignee+takenAt',
      'agent_activity(owner_id, since claim)',
      'test_runs(file_path, since claim, source<>mutation-probe)',
      'work_items.external_blockers_projection',
    ],
  };
}

/** Ledger reads, injectable so the derivation is testable without Postgres. */
export interface MechanicsLedger {
  writeRows(ownerId: string, sinceIso: string, limit: number): Promise<FileWriteLedgerRow[]>;
  testRuns(files: readonly string[], sinceIso: string): Promise<MechanicsTestRunRow[]>;
  blockers(workItemId: string): Promise<MechanicsBlockerRow[] | null>;
  repoRoots(harness: string | null | undefined): Promise<string[]>;
}

export function pgMechanicsLedger(workspaceId?: string | null): MechanicsLedger {
  const ws = () => resolveConcreteWorkspaceId(workspaceId);
  return {
    async writeRows(ownerId, sinceIso, limit) {
      const { sql } = getOrgPg();
      return sql<FileWriteLedgerRow[]>`
        SELECT detail->>'file' AS file, detail->>'command' AS command
          FROM harness_shared.agent_activity
         WHERE owner_id = ${ownerId}
           AND created_at >= ${sinceIso}::timestamptz
           AND ((detail ? 'file' AND summary LIKE '✎%') OR (detail ? 'command' AND summary LIKE '▶%'))
         ORDER BY id DESC
         LIMIT ${limit}`;
    },
    async testRuns(files, sinceIso) {
      if (files.length === 0) return [];
      const { sql } = getOrgPg();
      return sql<MechanicsTestRunRow[]>`
        SELECT file_path, status, finished_at::text AS finished_at, source, worktree_dirty, commit_sha,
               NULLIF(execution_details->>'passed', '')::int AS passed,
               NULLIF(execution_details->>'failed', '')::int AS failed
          FROM harness_shared.test_runs
         WHERE file_path = ANY(${files as string[]})
           AND finished_at >= ${sinceIso}::timestamptz
           AND source IS DISTINCT FROM 'mutation-probe'`;
    },
    async blockers(workItemId) {
      const { sql } = getOrgPg();
      const rows = await sql<Array<{ b: MechanicsBlockerRow[] | null }>>`
        SELECT external_blockers_projection AS b
          FROM harness_shared.work_items
         WHERE workspace_id = ${ws()} AND feature_id = ${workItemId}
         LIMIT 1`;
      const b = rows[0]?.b;
      return Array.isArray(b) ? b : [];
    },
    async repoRoots(harness) {
      const root = harness ? await resolveHarnessRepoRoot(harness) : null;
      return root ? [root] : [];
    },
  };
}

/** Read-time derivation for one work item. Returns null when the item has no live claim window. */
export async function readWorkItemMechanics(
  workItem: MechanicsWorkItem,
  ledger: MechanicsLedger = pgMechanicsLedger(),
  now: Date = new Date(),
): Promise<WorkItemMechanics | null> {
  const ownerId = workItem.assignee?.trim();
  const claimedAt = workItem.takenAt?.trim();
  if (!ownerId || !claimedAt || !Number.isFinite(Date.parse(claimedAt))) return null;
  const sinceIso = new Date(Date.parse(claimedAt)).toISOString();
  const [writeRows, repoRoots, blockers] = await Promise.all([
    ledger.writeRows(ownerId, sinceIso, MECHANICS_ACTIVITY_LIMIT),
    ledger.repoRoots(workItem.harness),
    ledger.blockers(workItem.id),
  ]);
  const written = extractFileWritePaths(writeRows)
    .map((p) => toRepoRelative(p, repoRoots))
    .filter((p): p is string => p !== null && isWorkProduct(p));
  const testRuns = await ledger.testRuns(relatedTestFiles(written), sinceIso);
  return deriveWorkItemMechanics({ workItem, writeRows, repoRoots, testRuns, blockers, now });
}
