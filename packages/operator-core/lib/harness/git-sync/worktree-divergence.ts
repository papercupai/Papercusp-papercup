/**
 * WI-10006476 / plan agent-capacity-and-cost-gcp-2026-09-30 D-055 — the persisted
 * `routines.metadata.worktree_divergence` state of a pot-git member, and the one
 * function allowed to build it.
 *
 * WHY: a real content conflict between a member's work and the hive head forks
 * the member silently and permanently. The integrator parks the member head
 * ("leave for the member to rebase", integrator.ts) and the member's ff-only
 * worktree advance returns `diverged-manual`, which the catch-up sweep did not
 * log. Nothing recorded the fork: S6 (P-525) ran 55+ min with the tower and a
 * joiner each missing the other's work and no line anywhere saying so.
 *
 * WHAT this records: only a divergence that will NOT resolve on its own, i.e.
 * one whose 3-way merge conflicts (`conflictPaths` non-empty). A clean
 * divergence is the normal window before the integrator merges this member's
 * head, so recording it would flag every member after every commit.
 *
 * A separate top-level key, not a field of `worktree_bridge`:
 * `patchRoutineMetadata` is a top-level jsonb merge (see worktree-bridge-state.ts),
 * so a field added there must be re-stated by every writer of that object. This
 * key has exactly one writer (`recordWorktreeDivergence` in git-sync-action.ts).
 */

/** The persisted shape (null = not diverged on a conflict). */
export interface WorktreeDivergence {
  /** First observation of THIS divergence (ms epoch). Kept while it persists,
   *  even as both heads move, so its age is readable. */
  since: number;
  /** Last tick that observed it (ms epoch). */
  lastSeenAt: number;
  /** The member worktree head at the last observation. */
  localHead: string;
  /** The accepted hive head (the watermark) at the last observation. */
  hiveSha: string;
  /** Conflicting paths, sorted. Never empty in a persisted value. */
  paths: string[];
  /** D-055 step 2 (WI-10006507): when the merge-resolver was dispatched for THIS
   *  conflicting path set (ms epoch). Absent = not yet dispatched. Carried while the
   *  path set is unchanged and dropped when it changes, so each distinct conflict is
   *  handed to the resolver once, never once per tick. */
  resolverDispatchedAt?: number;
  /** WI-10006833: the merge-resolver cannot run on THIS member because the agent CLI
   *  its role would exec is not on the spawn PATH (a Server install ships none).
   *  While set, the conflict is NOT dispatched: every dispatch would die
   *  `spawn <bin> ENOENT` (rc 127, empty stderr) and leave no record of why. It is a
   *  property of the member, not of the path set, so it is carried across path-set
   *  changes. Re-probed each tick while a dispatch is pending, and dropped once the
   *  runtime resolves. */
  resolverUnavailable?: ResolverUnavailable;
}

/** Why the D-055 resolver cannot run on this member. */
export interface ResolverUnavailable {
  /** The binary the resolver role would exec (e.g. `claude`). */
  runtime: string;
  reason: 'runtime-missing';
  /** First tick that found it missing (ms epoch). */
  since: number;
}

/** One preflight of the resolver role's agent CLI. */
export type ResolverRuntimeProbe = { ok: true } | { ok: false; runtime: string };

/** What one catch-up tick learned about the member worktree. */
export type DivergenceObservation =
  /** The worktree contains the hive head (current / advanced / noop). */
  | { kind: 'contained' }
  /** Diverged. `paths: []` = merges cleanly (transient); `null` = probe failed. */
  | { kind: 'diverged'; localHead: string; hiveSha: string; paths: string[] | null }
  /** Nothing learned (dirty deferral, a transport error): keep the prior state. */
  | { kind: 'unknown' };

/** What the caller should log for this transition. */
export type DivergenceLog = 'started' | 'paths-changed' | 'cleared' | null;

export interface DivergenceTransition {
  next: WorktreeDivergence | null;
  log: DivergenceLog;
  /** Whether the persisted value must be written this tick. */
  write: boolean;
}

/** Refresh `lastSeenAt` at most this often while nothing else changes, so a
 *  long divergence is not one metadata write per tick. */
export const DIVERGENCE_REFRESH_MS = 5 * 60_000;

function samePaths(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((p, i) => p === b[i]);
}

/** Read a persisted value defensively (hand-edited or older rows). */
export function parseWorktreeDivergence(raw: unknown): WorktreeDivergence | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const paths = Array.isArray(r.paths) ? r.paths.filter((p): p is string => typeof p === 'string') : [];
  if (
    typeof r.since !== 'number' ||
    typeof r.lastSeenAt !== 'number' ||
    typeof r.localHead !== 'string' ||
    typeof r.hiveSha !== 'string' ||
    paths.length === 0
  ) {
    return null;
  }
  return {
    since: r.since,
    lastSeenAt: r.lastSeenAt,
    localHead: r.localHead,
    hiveSha: r.hiveSha,
    paths,
    ...(typeof r.resolverDispatchedAt === 'number' ? { resolverDispatchedAt: r.resolverDispatchedAt } : {}),
    ...(parseResolverUnavailable(r.resolverUnavailable) ?? {}),
  };
}

function parseResolverUnavailable(raw: unknown): { resolverUnavailable: ResolverUnavailable } | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  if (typeof u.runtime !== 'string' || u.runtime === '' || typeof u.since !== 'number') return null;
  return { resolverUnavailable: { runtime: u.runtime, reason: 'runtime-missing', since: u.since } };
}

/** Pure transition: prior state + this tick's observation → next state. */
export function nextWorktreeDivergence(
  prior: WorktreeDivergence | null,
  obs: DivergenceObservation,
  now: number,
): DivergenceTransition {
  if (obs.kind === 'unknown') return { next: prior, log: null, write: false };
  if (obs.kind === 'diverged' && obs.paths === null) return { next: prior, log: null, write: false };

  const conflictPaths = obs.kind === 'diverged' ? [...(obs.paths as string[])].sort() : [];
  if (conflictPaths.length === 0) {
    // Contained, or a clean (self-resolving) divergence: no conflict fork.
    return prior ? { next: null, log: 'cleared', write: true } : { next: null, log: null, write: false };
  }

  const d = obs as Extract<DivergenceObservation, { kind: 'diverged' }>;
  const next: WorktreeDivergence = {
    since: prior?.since ?? now,
    lastSeenAt: now,
    localHead: d.localHead,
    hiveSha: d.hiveSha,
    paths: conflictPaths,
  };
  // WI-10006833: a missing resolver runtime belongs to the member, not the path set.
  if (prior?.resolverUnavailable) next.resolverUnavailable = prior.resolverUnavailable;
  if (!prior) return { next, log: 'started', write: true };
  // A new conflicting path set is a new conflict: it gets its own resolver dispatch.
  if (!samePaths(prior.paths, conflictPaths)) return { next, log: 'paths-changed', write: true };
  if (prior.resolverDispatchedAt !== undefined) next.resolverDispatchedAt = prior.resolverDispatchedAt;
  const headsMoved = prior.localHead !== d.localHead || prior.hiveSha !== d.hiveSha;
  const stale = now - prior.lastSeenAt >= DIVERGENCE_REFRESH_MS;
  if (headsMoved || stale) return { next, log: null, write: true };
  return { next: prior, log: null, write: false };
}

/** What git-sync hands the merge-resolver for a conflict divergence (D-055 step 2). */
export interface DivergenceResolverDispatch {
  /** Same shape as a git-sync `RepoConflict`: the member worktree is the superproject. */
  conflicts: { scope: string; conflictedFiles: string[] }[];
  /** The hive head to merge INTO the member's branch, as a sha rather than
   *  `refs/hive/staging`. The catch-up only fetches that ref when the object is
   *  missing, so the ref can trail the watermark; the sha is the commit the
   *  conflict probe actually merged against, and it is already local. */
  mergeRef: string;
}

/**
 * D-055 step 2 (WI-10006507): the dispatch for a recorded conflict divergence that
 * has not been handed to the resolver yet, or null. Step 1 only RECORDED the fork;
 * nothing resolved it, and the integrator parks the member until the member merges the
 * hive head itself. This is that merge, routed through the same resolver as an ordinary
 * git-sync conflict, with `mergeRef` replacing the push remote as the other side.
 */
export function divergenceResolverDispatch(d: WorktreeDivergence | null): DivergenceResolverDispatch | null {
  if (d === null || d.resolverDispatchedAt !== undefined || d.paths.length === 0) return null;
  // WI-10006833: a resolver that cannot spawn here is never dispatched.
  if (d.resolverUnavailable) return null;
  return { conflicts: [{ scope: 'superproject', conflictedFiles: [...d.paths] }], mergeRef: d.hiveSha };
}

/** Whether a conflict is waiting on a dispatch (so its resolver runtime is worth probing). */
export function divergenceAwaitsResolver(d: WorktreeDivergence | null): d is WorktreeDivergence {
  return d !== null && d.resolverDispatchedAt === undefined && d.paths.length > 0;
}

/** What changed when a runtime probe was applied (null = nothing to write or log). */
export type ResolverRuntimeChange = 'unavailable' | 'available' | null;

/**
 * WI-10006833: fold one preflight of the resolver role's agent CLI into a divergence
 * that awaits a dispatch. Missing → record `resolverUnavailable` (kept unchanged while
 * the same runtime stays missing, so `since` reads its age). Present → drop it, which
 * re-enables `divergenceResolverDispatch` on the same tick.
 */
export function applyResolverRuntimeProbe(
  d: WorktreeDivergence,
  probe: ResolverRuntimeProbe,
  now: number,
): { next: WorktreeDivergence; change: ResolverRuntimeChange } {
  if (probe.ok) {
    if (!d.resolverUnavailable) return { next: d, change: null };
    const { resolverUnavailable: _dropped, ...rest } = d;
    return { next: rest, change: 'available' };
  }
  if (d.resolverUnavailable?.runtime === probe.runtime) return { next: d, change: null };
  return {
    next: { ...d, resolverUnavailable: { runtime: probe.runtime, reason: 'runtime-missing', since: now } },
    change: 'unavailable',
  };
}

/**
 * WI-10006833: the `last_resolver.detail` for a failed resolver run (any dispatch, not
 * only D-055). `decisionLine` and `stderr` are empty when the agent CLI never started
 * (c1010k: rc 127, empty stderr, the cause only in stdout as
 * `spawn error: spawn claude ENOENT`), so fall back to the stdout tail the /invoke route
 * returns, and name a missing runtime explicitly.
 */
export function resolverFailureDetail(j: {
  decisionLine?: string;
  stderr?: string;
  rawStdoutTail?: string;
}): { detail: string; unavailable?: { runtime: string; reason: 'runtime-missing' } } {
  const tail = (j.rawStdoutTail ?? '').trim();
  const detail = (j.decisionLine?.trim() || j.stderr?.trim() || tail.slice(-400)).slice(0, 400);
  const enoent = /spawn (\S+) ENOENT/.exec(`${j.stderr ?? ''}\n${tail}`);
  return enoent ? { detail, unavailable: { runtime: enoent[1], reason: 'runtime-missing' } } : { detail };
}

/** The operator-facing line for a resolver-runtime change (null = nothing to log). */
export function describeResolverRuntimeChange(
  slug: string,
  d: WorktreeDivergence,
  change: ResolverRuntimeChange,
): string | null {
  if (change === null) return null;
  if (change === 'available') {
    return `[git-sync] ${slug}: the merge-resolver runtime is now available; dispatching the pending D-055 conflict.`;
  }
  const rt = d.resolverUnavailable?.runtime ?? '(unknown)';
  return (
    `[git-sync] ${slug}: D-055 conflict on ${d.paths.length} path(s) NOT dispatched: the merge-resolver ` +
    `would exec '${rt}', which is not on this member's spawn PATH (runtime-missing). The worktree stays ` +
    `diverged until that CLI is installed here or the conflict is resolved by hand. ` +
    `State: routines.metadata.worktree_divergence.resolverUnavailable (WI-10006833).`
  );
}

/** The operator-facing line for a logged transition (null = nothing to log). */
export function describeDivergenceTransition(
  slug: string,
  prior: WorktreeDivergence | null,
  t: DivergenceTransition,
  now: number,
): string | null {
  if (t.log === null) return null;
  if (t.log === 'cleared') {
    const mins = prior ? Math.round((now - prior.since) / 60_000) : 0;
    return (
      `[git-sync] ${slug}: worktree divergence from the hive head CLEARED after ~${mins}m ` +
      `(was conflicting on ${prior?.paths.length ?? 0} path(s)).`
    );
  }
  const n = t.next as WorktreeDivergence;
  const shown = n.paths.slice(0, 5).join(', ') + (n.paths.length > 5 ? `, +${n.paths.length - 5} more` : '');
  return (
    `[git-sync] ${slug}: worktree DIVERGED from the hive head ${n.hiveSha.slice(0, 12)} ` +
    `(local ${n.localHead.slice(0, 12)}) with a content conflict on ${n.paths.length} path(s): ${shown}. ` +
    `The integrator parks this member's work and this worktree cannot follow hive changes until the ` +
    `conflict is resolved on this member (plan agent-capacity-and-cost-gcp-2026-09-30 D-055). ` +
    `State: routines.metadata.worktree_divergence.` +
    (t.log === 'paths-changed' ? ' (conflicting path set changed)' : '')
  );
}
