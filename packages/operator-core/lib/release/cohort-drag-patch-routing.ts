/**
 * P-003 (change-provenance-and-admission-throughput-2026-10-27, bar R-3): route a cohort-drag
 * test to a committed-patch replay.
 *
 * A whole-blob admission refused `admission-incomplete` names test files that must come along
 * (they import an admitted path, or an admitted test imports them). Admitting such a test
 * whole-blob copies its newest blob — which can drag in other agents' later edits. When the
 * test's REPAIR-HEAD blob equals its blob in the PARENT of the commit that last changed it on
 * the integration branch, that one commit's delta is exactly the gap: replaying it
 * (`patchCommit`, see `buildCommittedPatchSource`) lands the same content without dragging
 * anything else in, because the replay diffs `parent..commit -- <that path>` only — never the
 * commit's other files.
 *
 * Proposal rule (exact): propose `{ patchCommit: C, paths: [path] }` iff
 *   - C = `git rev-list -n 1 <integrationRef> -- <path>` exists and has exactly one parent, and
 *   - the entry at `<repairHead>:<path>` equals the entry at `<C>^:<path>` (same mode and blob,
 *     or absent at both), and every entry involved is a regular file.
 * A file changed twice since the repair head fails the blob test (its last commit's parent
 * already carries the first change), so it is never proposed.
 *
 * Pure and synchronous: every step goes through one `AdmissionGitRunner`, so the admit door
 * runs it on the admission worker (job kind `cohort-drag-route`) like every other git step.
 */
import { normalizeAdmissionPath, realAdmissionGit, type AdmissionGitRunner } from './repair-head-admission';

const SHA_RE = /^[0-9a-f]{40,64}$/;
/** Bounds one routing pass; a refusal naming more tests than this is reported, not routed. */
export const COHORT_DRAG_ROUTE_MAX_PATHS = 50;

/** The same test-file rule the whole-blob cohort check uses to pick the paths it refuses. */
export function isCohortTestPath(path: string): boolean {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);
}

export interface CohortDragRouted {
  path: string;
  /** The commit whose delta to `path` is replayed. */
  patchCommit: string;
  /** Its only parent — where the pre-fix blob was read. */
  parent: string;
  /** The equal pre-fix / repair-head blob id, or null when the file is absent at both. */
  preFixBlob: string | null;
}

export type CohortDragUnroutedReason =
  | 'not-a-test'
  | 'invalid-path'
  | 'no-commit-on-integration'
  | 'merge-or-root-commit'
  | 'not-a-regular-file'
  | 'repair-head-differs'
  | 'over-limit';

export interface CohortDragUnrouted {
  path: string;
  reason: CohortDragUnroutedReason;
  patchCommit?: string;
  repairHeadBlob?: string | null;
  preFixBlob?: string | null;
}

export type CohortDragRouting =
  | { ok: true; routed: CohortDragRouted[]; unrouted: CohortDragUnrouted[] }
  | { ok: false; code: 'git-failed'; step: string; detail: string };

export interface CohortDragRouteInput {
  root: string;
  repairHead: string;
  /** The LOCAL integration branch (e.g. `staging`) — the history the gate's candidates come from. */
  integrationRef: string;
  /** The refused paths; non-test paths are reported `not-a-test` and never routed. */
  paths: readonly string[];
  git?: AdmissionGitRunner;
}

type Entry = { mode: string; type: string; oid: string };

export function routeCohortDragTests(input: CohortDragRouteInput): CohortDragRouting {
  const git = input.git ?? realAdmissionGit;
  const run = (args: string[]) =>
    git(args, { cwd: input.root, env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' } });
  const failed = (step: string, r: { status: number | null; stdout: string; stderr: string }): CohortDragRouting => ({
    ok: false,
    code: 'git-failed',
    step,
    detail: `exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`,
  });

  const routed: CohortDragRouted[] = [];
  const unrouted: CohortDragUnrouted[] = [];
  const candidates: string[] = [];
  for (const raw of [...new Set(input.paths)]) {
    const path = normalizeAdmissionPath(raw);
    if (path === null) unrouted.push({ path: raw, reason: 'invalid-path' });
    else if (!isCohortTestPath(path)) unrouted.push({ path, reason: 'not-a-test' });
    else if (candidates.length >= COHORT_DRAG_ROUTE_MAX_PATHS) unrouted.push({ path, reason: 'over-limit' });
    else candidates.push(path);
  }
  if (candidates.length === 0) return { ok: true, routed, unrouted };

  const head = run(['rev-parse', '--verify', `${input.repairHead}^{commit}`]);
  if (head.status !== 0 || !SHA_RE.test(head.stdout.trim())) return failed('resolve repair head', head);
  const repairHead = head.stdout.trim();

  // The last commit that changed each path. A pathspec with --parents would print the
  // REWRITTEN (simplified) parents, so real parents are read separately below.
  const lastCommit = new Map<string, string>();
  for (const path of candidates) {
    const r = run(['rev-list', '-n', '1', input.integrationRef, '--', path]);
    if (r.status !== 0) return failed('find last commit', r);
    const sha = r.stdout.trim();
    if (!sha) unrouted.push({ path, reason: 'no-commit-on-integration' });
    else if (!SHA_RE.test(sha)) return failed('find last commit', { ...r, stderr: `unexpected output ${JSON.stringify(sha.slice(0, 80))}` });
    else lastCommit.set(path, sha);
  }
  const commits = [...new Set(lastCommit.values())];
  const parentOf = new Map<string, string | null>();
  if (commits.length) {
    const r = run(['rev-list', '--no-walk=unsorted', '--parents', ...commits, '--']);
    if (r.status !== 0) return failed('read commit parents', r);
    for (const line of r.stdout.split('\n').filter(Boolean)) {
      const [sha, ...parents] = line.trim().split(/\s+/);
      parentOf.set(sha!, parents.length === 1 && SHA_RE.test(parents[0]!) ? parents[0]! : null);
    }
  }

  // One ls-tree per tree read: the repair head over every candidate, each commit and parent over its own paths.
  const entriesAt = (ref: string, paths: string[]): Map<string, Entry> | CohortDragRouting => {
    const r = run(['ls-tree', '-z', ref, '--', ...paths]);
    if (r.status !== 0) return failed(`read entries at ${ref.slice(0, 12)}`, r);
    const out = new Map<string, Entry>();
    for (const line of r.stdout.split('\0').filter(Boolean)) {
      const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(line);
      if (!m) return failed(`read entries at ${ref.slice(0, 12)}`, { ...r, stderr: 'malformed ls-tree entry' });
      out.set(m[4]!, { mode: m[1]!, type: m[2]!, oid: m[3]! });
    }
    return out;
  };
  const isMap = (v: Map<string, Entry> | CohortDragRouting): v is Map<string, Entry> => v instanceof Map;
  const regular = (e: Entry | undefined) => e === undefined || (e.type === 'blob' && (e.mode === '100644' || e.mode === '100755'));

  if (lastCommit.size === 0) return { ok: true, routed, unrouted };
  const atHead = entriesAt(repairHead, [...lastCommit.keys()]);
  if (!isMap(atHead)) return atHead;
  const byCommit = new Map<string, string[]>();
  for (const [path, sha] of lastCommit) byCommit.set(sha, [...(byCommit.get(sha) ?? []), path]);

  for (const [sha, paths] of byCommit) {
    const parent = parentOf.get(sha) ?? null;
    if (parent === null) {
      for (const path of paths) unrouted.push({ path, reason: 'merge-or-root-commit', patchCommit: sha });
      continue;
    }
    const atParent = entriesAt(parent, paths);
    if (!isMap(atParent)) return atParent;
    const atCommit = entriesAt(sha, paths);
    if (!isMap(atCommit)) return atCommit;
    for (const path of paths) {
      const h = atHead.get(path);
      const p = atParent.get(path);
      if (!regular(h) || !regular(p) || !regular(atCommit.get(path))) {
        unrouted.push({ path, reason: 'not-a-regular-file', patchCommit: sha });
        continue;
      }
      const same = h === undefined ? p === undefined : p !== undefined && h.oid === p.oid && h.mode === p.mode;
      if (same) routed.push({ path, patchCommit: sha, parent, preFixBlob: p?.oid ?? null });
      else unrouted.push({ path, reason: 'repair-head-differs', patchCommit: sha, repairHeadBlob: h?.oid ?? null, preFixBlob: p?.oid ?? null });
    }
  }
  const order = new Map(input.paths.map((p, i) => [normalizeAdmissionPath(p) ?? p, i]));
  const byInput = (a: { path: string }, b: { path: string }) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0);
  return { ok: true, routed: routed.sort(byInput), unrouted: unrouted.sort(byInput) };
}
