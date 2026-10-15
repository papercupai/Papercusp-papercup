/**
 * pot-review-integration-mode P-016 (D-006/D-007): SYNC-BACK.
 *
 * A working-copy ("review") pot pushes its own fork; the main repository only
 * receives work through the standing PR. When the main repository's `main` moves —
 * including when it merges OUR standing PR — the working copy must absorb it, or
 * the next PR re-lists already-merged commits and drifts further from upstream.
 *
 * In review mode `applyIntegrationPushTarget` repoints `cfg.remote` at the fork
 * (`pot-fork`), so `origin` still names the MAIN repository. Sync-back therefore
 * fetches `origin/<mainBranch>` and merges it into the copy's integration branch.
 *
 * A conflict is aborted to a clean tree and reported (never left half-merged, never
 * resolved by picking a side): the caller turns it into a fix-it work-item in the pot.
 *
 * Submodules (plan slack-asana-reproduced-bug-fix-pr-workflow-2026-10-08 P-014,
 * decision D-017 §4): when the main repository moves a gitlink, the submodule's
 * checkout absorbs that exact commit FIRST (fast-forward, or a merge preflighted with
 * `merge-tree`), so the superproject merge records a pin the checkout actually holds.
 * Otherwise the next commit would record the checkout's stale HEAD and silently revert
 * the upstream bump. A gitlink-only conflict whose submodule HEAD contains both sides is
 * resolved to that HEAD; anything else is reported before any repository is changed.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseGitlinkDiff, parseUnmergedEntries } from './gitlinks';

export type SyncBackRunGit = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface SyncBackConfig {
  /** Remote naming the MAIN repository (`origin` in review mode). */
  upstreamRemote: string;
  /** The main repository's integration target, normally `main`. */
  upstreamBranch: string;
}

export type SyncBackDecision =
  | { action: 'skip'; reason: string }
  | { action: 'up-to-date'; upstreamSha: string }
  | { action: 'merge'; upstreamSha: string };

/** Pure: what sync-back should do given what git reported. */
export function decideSyncBack(input: {
  /** Only the copy's integration branch (staging) absorbs upstream. */
  currentBranch: string;
  integrationBranch: string;
  /** Resolved upstream tip after the fetch, or null when it could not be resolved. */
  upstreamSha: string | null;
  /** `git merge-base --is-ancestor upstream HEAD` succeeded. */
  upstreamIsAncestorOfHead: boolean;
}): SyncBackDecision {
  if (input.currentBranch !== input.integrationBranch) {
    return {
      action: 'skip',
      reason: `on '${input.currentBranch}', not the integration branch '${input.integrationBranch}'`,
    };
  }
  if (!input.upstreamSha) return { action: 'skip', reason: 'upstream tip could not be resolved' };
  if (input.upstreamIsAncestorOfHead) return { action: 'up-to-date', upstreamSha: input.upstreamSha };
  return { action: 'merge', upstreamSha: input.upstreamSha };
}

export type SyncBackResult =
  | { status: 'skipped'; reason: string }
  | { status: 'up-to-date'; upstreamSha: string }
  | {
      status: 'merged';
      upstreamSha: string;
      mergedSha: string;
      /**
       * D-017 §4: submodule checkouts (superproject-relative paths) that absorbed an
       * upstream pin this tick. Their new commits are not on the submodule forks yet,
       * so the caller must not publish the superproject until they are.
       */
      absorbedSubmodules?: string[];
    }
  | { status: 'conflict'; upstreamSha: string; conflictedFiles: string[] }
  | { status: 'error'; message: string };

const detail = (r: { code: number; stdout: string; stderr: string }): string =>
  (r.stderr.trim() || r.stdout.trim() || `git exited with code ${r.code}`).slice(0, 300);

/**
 * Fetch the main repository's branch and merge it into the current branch when it is
 * not already contained. Never leaves the tree mid-merge.
 */
export async function runSyncBack(
  runGit: SyncBackRunGit,
  repoPath: string,
  opts: SyncBackConfig & {
    integrationBranch: string;
    /** Network leg (fetch); defaults to `runGit`. git-sync passes its HTTPS-fallback runner. */
    runNetworkGit?: SyncBackRunGit;
    /** Identity args for the merge commit (`-c user.name=… -c user.email=…`). */
    identityArgs?: string[];
    log?: (message: string) => void;
  },
): Promise<SyncBackResult> {
  const network = opts.runNetworkGit ?? runGit;
  const log = opts.log ?? (() => {});
  const upstreamRef = `refs/remotes/${opts.upstreamRemote}/${opts.upstreamBranch}`;

  const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
  if (branch.code !== 0) return { status: 'error', message: `could not read current branch: ${detail(branch)}` };
  const currentBranch = branch.stdout.trim();
  if (currentBranch !== opts.integrationBranch) {
    const d = decideSyncBack({
      currentBranch,
      integrationBranch: opts.integrationBranch,
      upstreamSha: null,
      upstreamIsAncestorOfHead: false,
    });
    return { status: 'skipped', reason: d.action === 'skip' ? d.reason : 'not the integration branch' };
  }

  const fetched = await network(
    ['fetch', '--no-tags', opts.upstreamRemote, `+refs/heads/${opts.upstreamBranch}:${upstreamRef}`],
    repoPath,
  );
  if (fetched.code !== 0) {
    return { status: 'error', message: `sync-back fetch of ${opts.upstreamRemote}/${opts.upstreamBranch} failed: ${detail(fetched)}` };
  }
  const resolved = await runGit(['rev-parse', '--verify', '--quiet', `${upstreamRef}^{commit}`], repoPath);
  const upstreamSha = resolved.code === 0 ? resolved.stdout.trim() || null : null;
  const ancestor = upstreamSha
    ? await runGit(['merge-base', '--is-ancestor', upstreamSha, 'HEAD'], repoPath)
    : { code: 1, stdout: '', stderr: '' };

  const decision = decideSyncBack({
    currentBranch,
    integrationBranch: opts.integrationBranch,
    upstreamSha,
    upstreamIsAncestorOfHead: ancestor.code === 0,
  });
  if (decision.action === 'skip') return { status: 'skipped', reason: decision.reason };
  if (decision.action === 'up-to-date') return { status: 'up-to-date', upstreamSha: decision.upstreamSha };

  // D-017 §4: submodule checkouts absorb the pins upstream moved, before the superproject
  // merge. Planned (preflighted) first, so a conflict changes no repository.
  const hasSubmodules = existsSync(join(repoPath, '.gitmodules'));
  let absorbedSubmodules: string[] = [];
  if (hasSubmodules) {
    const ctx: AbsorbContext = { runGit, network, identityArgs: opts.identityArgs ?? [] };
    const plan = await planMergeWithSubmodules(ctx, repoPath, decision.upstreamSha, '', 0);
    if (!plan.ok && plan.conflict) {
      log(
        `[git-sync] ${repoPath}: sync-back of ${opts.upstreamRemote}/${opts.upstreamBranch} would conflict in ` +
          `${plan.conflictedFiles.length} path(s); nothing changed`,
      );
      return { status: 'conflict', upstreamSha: decision.upstreamSha, conflictedFiles: plan.conflictedFiles };
    }
    if (!plan.ok) return { status: 'error', message: `sync-back submodule preflight failed: ${plan.message}` };
    for (const step of plan.absorb) {
      const failed = await executeAbsorption(ctx, step);
      if (failed) return { status: 'error', message: failed };
    }
    absorbedSubmodules = absorbedPaths(plan.absorb);
    for (const path of absorbedSubmodules) {
      log(`[git-sync] ${repoPath}: submodule '${path}' absorbed its upstream pin before the sync-back merge`);
    }
  }

  const merge = await runGit(
    [
      ...(opts.identityArgs ?? []),
      'merge',
      '--no-edit',
      '-m',
      `git-sync: sync-back ${opts.upstreamRemote}/${opts.upstreamBranch} (${decision.upstreamSha.slice(0, 12)})`,
      decision.upstreamSha,
    ],
    repoPath,
  );
  const resolvedGitlinks =
    merge.code !== 0 && hasSubmodules ? await resolveGitlinkOnlyConflicts(runGit, repoPath, opts.identityArgs ?? []) : null;
  if (merge.code !== 0 && !resolvedGitlinks?.ok) {
    const unmerged = await runGit(['diff', '--name-only', '--diff-filter=U', '-z'], repoPath);
    const conflictedFiles = unmerged.code === 0 ? unmerged.stdout.split('\0').filter(Boolean) : [];
    await runGit(['merge', '--abort'], repoPath);
    if (conflictedFiles.length === 0) {
      return { status: 'error', message: `sync-back merge failed (no conflicted paths): ${detail(merge)}` };
    }
    log(
      `[git-sync] ${repoPath}: sync-back of ${opts.upstreamRemote}/${opts.upstreamBranch} conflicts in ` +
        `${conflictedFiles.length} path(s); aborted to a clean tree`,
    );
    return { status: 'conflict', upstreamSha: decision.upstreamSha, conflictedFiles };
  }
  const head = await runGit(['rev-parse', 'HEAD'], repoPath);
  log(`[git-sync] ${repoPath}: synced back ${opts.upstreamRemote}/${opts.upstreamBranch} @ ${decision.upstreamSha.slice(0, 12)}`);
  return {
    status: 'merged',
    upstreamSha: decision.upstreamSha,
    mergedSha: head.stdout.trim(),
    ...(absorbedSubmodules.length ? { absorbedSubmodules } : {}),
  };
}

// ─── D-017 §4: submodule checkouts absorb the pins upstream moved ────────────

interface AbsorbContext {
  runGit: SyncBackRunGit;
  network: SyncBackRunGit;
  identityArgs: string[];
}

type MergePlan =
  | { ok: true; kind: 'contained' | 'fast-forward' | 'merge'; absorb: SubmoduleAbsorption[] }
  | { ok: false; conflict: true; conflictedFiles: string[] }
  | { ok: false; conflict: false; message: string };

/** One submodule checkout that must take `target` before its parent merges. */
interface SubmoduleAbsorption {
  /** Superproject-relative path (for messages and the result). */
  path: string;
  dir: string;
  target: string;
  plan: Extract<MergePlan, { ok: true }>;
}

const MAX_SUBMODULE_DEPTH = 8;

const short = (sha: string): string => sha.slice(0, 12);

/** Make sure `sha` is a local commit in `dir`, fetching from its `origin` (its main repository) if not. */
async function ensureCommitLocal(ctx: AbsorbContext, dir: string, sha: string): Promise<boolean> {
  const present = async (): Promise<boolean> => (await ctx.runGit(['cat-file', '-e', `${sha}^{commit}`], dir)).code === 0;
  if (await present()) return true;
  await ctx.network(['fetch', '--no-tags', 'origin'], dir);
  if (await present()) return true;
  await ctx.network(['fetch', '--no-tags', 'origin', sha], dir);
  return present();
}

/**
 * Plan merging `target` into the checkout at `dir` WITHOUT changing it: which nested
 * submodule checkouts must absorb the gitlinks `target` moves, and whether the merge
 * itself is contained / a fast-forward / a merge. A merge conflict is acceptable only
 * on a gitlink whose checked-out submodule absorbs the upstream side first (that
 * submodule's HEAD then contains both sides). Fetches objects; mutates nothing else.
 */
async function planMergeWithSubmodules(
  ctx: AbsorbContext,
  dir: string,
  target: string,
  prefix: string,
  depth: number,
): Promise<MergePlan> {
  const label = prefix ? `submodule '${prefix}'` : 'the working copy';
  if ((await ctx.runGit(['merge-base', '--is-ancestor', target, 'HEAD'], dir)).code === 0) {
    return { ok: true, kind: 'contained', absorb: [] };
  }
  const fastForward = (await ctx.runGit(['merge-base', '--is-ancestor', 'HEAD', target], dir)).code === 0;

  const absorb: SubmoduleAbsorption[] = [];
  const movedCheckouts = new Set<string>();
  if (depth <= MAX_SUBMODULE_DEPTH && existsSync(join(dir, '.gitmodules'))) {
    const base = await ctx.runGit(['merge-base', 'HEAD', target], dir);
    if (base.code !== 0) return { ok: false, conflict: false, message: `${label} shares no history with ${short(target)}` };
    const diff = await ctx.runGit(['diff', '--raw', '--no-abbrev', '--no-renames', base.stdout.trim(), target], dir);
    if (diff.code !== 0) return { ok: false, conflict: false, message: `${label}: ${detail(diff)}` };
    for (const link of parseGitlinkDiff(diff.stdout)) {
      const subDir = join(dir, link.path);
      const fullPath = prefix ? `${prefix}/${link.path}` : link.path;
      // Not checked out: the parent's merge alone records the pin; nothing local diverges.
      if (!existsSync(join(subDir, '.git'))) continue;
      movedCheckouts.add(link.path);
      if (!(await ensureCommitLocal(ctx, subDir, link.sha))) {
        return {
          ok: false,
          conflict: false,
          message: `submodule '${fullPath}': upstream pins ${short(link.sha)}, which its main repository does not serve`,
        };
      }
      const sub = await planMergeWithSubmodules(ctx, subDir, link.sha, fullPath, depth + 1);
      if (!sub.ok) return sub;
      if (sub.kind !== 'contained') absorb.push({ path: fullPath, dir: subDir, target: link.sha, plan: sub });
    }
  }
  if (fastForward) return { ok: true, kind: 'fast-forward', absorb };

  const preflight = await ctx.runGit(['merge-tree', '--write-tree', '--name-only', '--no-messages', 'HEAD', target], dir);
  if (preflight.code !== 0 && preflight.code !== 1) {
    return { ok: false, conflict: false, message: `${label}: merge preflight failed: ${detail(preflight)}` };
  }
  const conflicted = preflight.code === 1 ? [...new Set(preflight.stdout.split('\n').slice(1).map((l) => l.trim()).filter(Boolean))] : [];
  const unresolvable = conflicted.filter((p) => !movedCheckouts.has(p));
  if (unresolvable.length) {
    return { ok: false, conflict: true, conflictedFiles: unresolvable.map((p) => (prefix ? `${prefix}/${p}` : p)) };
  }
  return { ok: true, kind: 'merge', absorb };
}

/** Superproject-relative paths of every checkout an absorption plan changes, deepest first. */
function absorbedPaths(steps: readonly SubmoduleAbsorption[]): string[] {
  return steps.flatMap((s) => [...absorbedPaths(s.plan.absorb), s.path]);
}

/**
 * Carry out one planned absorption: nested checkouts first, then this checkout takes its
 * pin. Returns an error message, or null on success. A failed merge is aborted.
 */
async function executeAbsorption(ctx: AbsorbContext, step: SubmoduleAbsorption): Promise<string | null> {
  for (const nested of step.plan.absorb) {
    const failed = await executeAbsorption(ctx, nested);
    if (failed) return failed;
  }
  if (step.plan.kind === 'fast-forward') {
    const ff = await ctx.runGit(['merge', '--ff-only', step.target], step.dir);
    return ff.code === 0 ? null : `submodule '${step.path}': fast-forward to its upstream pin ${short(step.target)} failed: ${detail(ff)}`;
  }
  const merge = await ctx.runGit(
    [...ctx.identityArgs, 'merge', '--no-edit', '-m', `git-sync: sync-back absorbs the upstream pin ${short(step.target)}`, step.target],
    step.dir,
  );
  if (merge.code === 0) return null;
  const resolved = await resolveGitlinkOnlyConflicts(ctx.runGit, step.dir, ctx.identityArgs);
  if (resolved.ok) return null;
  await ctx.runGit(['merge', '--abort'], step.dir);
  return `submodule '${step.path}': merging its upstream pin ${short(step.target)} failed: ${resolved.message}`;
}

/**
 * After a failed merge in `dir`: when EVERY conflicted path is a gitlink whose checked-out
 * submodule HEAD already contains both sides, record that HEAD and conclude the merge.
 * Anything else is left for the caller to abort. Never picks a side.
 */
async function resolveGitlinkOnlyConflicts(
  runGit: SyncBackRunGit,
  dir: string,
  identityArgs: readonly string[],
): Promise<{ ok: true } | { ok: false; message: string }> {
  const listed = await runGit(['ls-files', '-u', '-z'], dir);
  if (listed.code !== 0) return { ok: false, message: detail(listed) };
  const entries = parseUnmergedEntries(listed.stdout);
  if (entries.length === 0) return { ok: false, message: 'the merge failed with no conflicted paths' };
  const notGitlinks = [...new Set(entries.filter((e) => e.mode !== '160000').map((e) => e.path))];
  if (notGitlinks.length) return { ok: false, message: `content conflicts in ${notGitlinks.join(', ')}` };
  const paths = [...new Set(entries.map((e) => e.path))];
  for (const path of paths) {
    const subDir = join(dir, path);
    if (!existsSync(join(subDir, '.git'))) return { ok: false, message: `gitlink '${path}' conflicts and is not checked out` };
    for (const side of entries.filter((e) => e.path === path && e.stage !== 1)) {
      if ((await runGit(['merge-base', '--is-ancestor', side.sha, 'HEAD'], subDir)).code !== 0) {
        return { ok: false, message: `gitlink '${path}': the submodule checkout does not contain ${short(side.sha)}` };
      }
    }
  }
  const added = await runGit(['add', '--', ...paths], dir);
  if (added.code !== 0) return { ok: false, message: detail(added) };
  const committed = await runGit([...identityArgs, 'commit', '--no-edit'], dir);
  return committed.code === 0 ? { ok: true } : { ok: false, message: detail(committed) };
}

/** Stable title for the fix-it work-item a sync-back conflict files in the pot (dedupe key). */
export function syncBackConflictTitle(upstreamRemote: string, upstreamBranch: string, upstreamSha: string): string {
  return `${syncBackConflictTitlePrefix(upstreamRemote, upstreamBranch)} @ ${upstreamSha.slice(0, 12)} into the working copy`;
}

/**
 * The sha-free head of {@link syncBackConflictTitle}. Dedupe matches on THIS, not the full
 * title: while one conflict stays unresolved, upstream keeps advancing, and a sha-keyed
 * dedupe would file a fresh fix-it item on every upstream push for the same stuck merge.
 */
export function syncBackConflictTitlePrefix(upstreamRemote: string, upstreamBranch: string): string {
  return `Sync-back conflict: merge ${upstreamRemote}/${upstreamBranch}`;
}

export interface SyncBackConflictFilingDeps {
  /** Id of an OPEN (non-terminal) work-item whose title starts with `titlePrefix`, or null. */
  findOpenByTitlePrefix(titlePrefix: string): Promise<string | null>;
  /** Create the fix-it work-item; returns its id. */
  create(input: { title: string; summary: string }): Promise<string>;
}

/**
 * The watchdog key a pot's sync-back conflict is filed under. The dedupe lookup and the
 * create MUST use this one function: if they ever diverge, the lookup never finds the
 * item it filed and a stuck merge re-files a fresh work-item on every tick.
 */
export function syncBackConflictWatchdogKey(slug: string, titlePrefix: string): string {
  return `git-sync:sync-back-conflict:${slug}:${titlePrefix}`;
}

const TERMINAL_STATES = new Set(['done', 'dropped', 'resolved', 'closed']);
/** Cap on conflicted paths attached to the filed item (the summary still lists them all). */
export const SYNC_BACK_CONFLICT_PATHS_CAP = 20;

export interface SyncBackConflictCaptureInput {
  title: string;
  kind: 'bug';
  severity: 'major';
  body: string;
  watchdogKey: string;
  workspaceId: string;
  scope: string;
  sourceRole: 'system';
  filedByRole: 'git-sync';
  createdBy: 'system:git-sync';
  paths: string[];
}

/** The two persistence seams the real filing uses; injectable so the wiring is testable. */
export interface SyncBackConflictFilingSinks {
  findIssuesByWatchdogKeys(keys: string[]): Promise<ReadonlyArray<{ id: unknown; state?: unknown }>>;
  captureImprovement(input: SyncBackConflictCaptureInput): Promise<{ issue?: { id?: unknown } | null }>;
}

const defaultFilingSinks: SyncBackConflictFilingSinks = {
  findIssuesByWatchdogKeys: async (keys) => (await import('../../issues-engineer')).findIssuesByWatchdogKeys(keys),
  captureImprovement: async (input) => (await import('../improvements/capture-core')).captureImprovement(input),
};

/**
 * The production {@link SyncBackConflictFilingDeps} for one pot: an OPEN item under the
 * pot's sync-back watchdog key is the dedupe hit; otherwise a `major` bug is filed in the
 * pot (`harness:<slug>`) under that same key, carrying the conflicted paths.
 */
export function makeSyncBackConflictFilingDeps(
  input: { slug: string; workspaceId: string; cfg: SyncBackConfig; conflictedFiles: readonly string[] },
  sinks: SyncBackConflictFilingSinks = defaultFilingSinks,
): SyncBackConflictFilingDeps {
  const { slug, workspaceId, cfg, conflictedFiles } = input;
  return {
    findOpenByTitlePrefix: async (prefix) => {
      const found = await sinks.findIssuesByWatchdogKeys([syncBackConflictWatchdogKey(slug, prefix)]);
      const open = found.find((i) => !TERMINAL_STATES.has(String(i.state)));
      return open ? String(open.id) : null;
    },
    create: async ({ title, summary }) => {
      const res = await sinks.captureImprovement({
        title,
        kind: 'bug',
        severity: 'major',
        body: summary,
        watchdogKey: syncBackConflictWatchdogKey(slug, syncBackConflictTitlePrefix(cfg.upstreamRemote, cfg.upstreamBranch)),
        workspaceId,
        scope: `harness:${slug}`,
        sourceRole: 'system',
        filedByRole: 'git-sync',
        createdBy: 'system:git-sync',
        paths: conflictedFiles.slice(0, SYNC_BACK_CONFLICT_PATHS_CAP),
      });
      return String(res.issue?.id ?? '');
    },
  };
}

export type SyncBackConflictFiling =
  | { action: 'none' }
  | { action: 'exists'; id: string }
  | { action: 'filed'; id: string };

/**
 * P-016: "Conflicts become a fix-it work-item in the pot." git-sync's own conflict path
 * (escalation + merge-resolver) merges against the PUSH remote's staging, so it cannot
 * resolve a conflict against the MAIN repo's branch; a sync-back conflict therefore files
 * its own work-item, once per stuck merge (deduped on the open title prefix).
 */
export async function fileSyncBackConflict(
  result: SyncBackResult | undefined,
  cfg: SyncBackConfig,
  deps: SyncBackConflictFilingDeps,
): Promise<SyncBackConflictFiling> {
  if (!result || result.status !== 'conflict') return { action: 'none' };
  const existing = await deps.findOpenByTitlePrefix(syncBackConflictTitlePrefix(cfg.upstreamRemote, cfg.upstreamBranch));
  if (existing) return { action: 'exists', id: existing };
  const upstreamRef = `${cfg.upstreamRemote}/${cfg.upstreamBranch}`;
  const files = result.conflictedFiles.map((f) => `- ${f}`).join('\n');
  const summary = [
    `git-sync could not merge the main repository's ${upstreamRef} (${result.upstreamSha.slice(0, 12)}) into this working copy's staging branch.`,
    `The merge was aborted, so staging is clean but stays behind the main repository until this is resolved,`,
    `and the next pull request will keep showing changes the main repository already has.`,
    '',
    `Conflicted paths (${result.conflictedFiles.length}):`,
    files,
    '',
    'To resolve, on the working copy checkout with staging checked out:',
    `1. git fetch ${cfg.upstreamRemote} ${cfg.upstreamBranch}`,
    `2. git merge ${upstreamRef}`,
    '3. Resolve the conflicted paths and commit the merge.',
    'git-sync pushes the merge commit on its next tick; sync-back then reports up-to-date.',
  ].join('\n');
  const id = await deps.create({
    title: syncBackConflictTitle(cfg.upstreamRemote, cfg.upstreamBranch, result.upstreamSha),
    summary,
  });
  return { action: 'filed', id };
}
