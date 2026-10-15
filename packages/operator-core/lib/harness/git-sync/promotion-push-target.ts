/**
 * pot-review-integration-mode P-020 (D-006/D-007): where green-checkpoint
 * PUBLISHES a promoted commit.
 *
 * git-sync already routes a working-copy (review-mode) pot's pushes to the
 * pot's own fork (`pot-fork` remote) and never to the main repository. The
 * green gate's promotion push used to bypass that: it pushed the tested
 * candidate to `origin` — the MAIN repository — unconditionally, so a
 * review-mode pot's promoted `main` landed straight on the upstream `main`
 * without any PR. This module is the single decision both halves now share:
 * it resolves the pot that owns the integration checkout, reads its
 * integration mode through the SAME `resolveIntegrationPushRemote` git-sync
 * uses, and maps that to a promotion target.
 *
 *  - `origin` — direct mode, or a checkout no registered pot owns: today's
 *    behaviour, unchanged.
 *  - `fork`   — review mode with a fork: push the promoted commit to the fork,
 *    then refresh the standing PR (fork main → upstream main).
 *  - `skip`   — review mode with no fork: publish nowhere (the local gate is
 *    still authoritative, like a local-only repository). Never falls back to
 *    the main repository.
 *  - `hold`   — the mode could not be determined (settings read error,
 *    malformed value, unreadable registry). Fail CLOSED: the caller throws so
 *    promotion is held rather than risking an upstream leak.
 */
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectEntry } from '../../harness-registry';
import { STANDING_PR_BRANCH } from './decide-standing-pr';
import {
  POT_FORK_REMOTE_NAME,
  repoHasSubmodules,
  resolveIntegrationPushRemote,
  type PotIntegrationModeRead,
} from './pot-integration-mode';
import {
  publishStandingPr,
  type PublishStandingPrResult,
  type StandingPrDeps,
  type SubmodulePrLink,
} from './standing-pr';
import type { SubmoduleForksRead, UnpublishedGitlink } from './submodule-forks';

export type PromotionPushTarget =
  | { kind: 'origin'; reason: string }
  | {
      kind: 'fork';
      remoteName: typeof POT_FORK_REMOTE_NAME;
      url: string;
      potHomeSlug: string;
      integration: PotIntegrationModeRead;
      /** The main repository's GitHub remote (registry `github_remote`), for the standing PR. */
      upstreamRemote?: string;
      reason: string;
    }
  | { kind: 'skip'; reason: 'working_copy_fork_missing'; message: string }
  | {
      kind: 'hold';
      reason: 'integration_mode_unknown' | 'integration_mode_malformed' | 'registry_unreadable';
      message: string;
    };

export interface ResolvePromotionPushTargetInput {
  /** The integration checkout green-checkpoint promotes (cfg.integrationRoot). */
  repoPath: string;
  /** Workspace whose registry owns the checkout; undefined = the registry default. */
  workspaceId?: string;
}

export interface ResolvePromotionPushTargetDeps {
  loadProjects: (workspaceId: string | undefined) => Promise<readonly ProjectEntry[]>;
  readMode: (workspaceId: string, potHomeSlug: string) => Promise<PotIntegrationModeRead>;
  /** Canonicalise a path for comparison; defaults to realpath with a raw fallback. */
  canonical?: (p: string) => string;
}

function defaultCanonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p.replace(/\/+$/, '');
  }
}

/** Decide where a promoted commit is published. Never throws. */
export async function resolvePromotionPushTarget(
  input: ResolvePromotionPushTargetInput,
  deps: ResolvePromotionPushTargetDeps,
): Promise<PromotionPushTarget> {
  const canonical = deps.canonical ?? defaultCanonical;
  let projects: readonly ProjectEntry[];
  try {
    projects = await deps.loadProjects(input.workspaceId);
  } catch (err) {
    return {
      kind: 'hold',
      reason: 'registry_unreadable',
      message:
        `could not load the harness registry (${err instanceof Error ? err.message : String(err)}) — ` +
        'holding promotion: without it a working-copy pot cannot be told apart from a direct one',
    };
  }
  const target = canonical(input.repoPath);
  const entry = projects.find((p) => typeof p.path === 'string' && p.path && canonical(p.path) === target);
  if (!entry) return { kind: 'origin', reason: 'no registered pot owns this checkout — publishing to origin' };
  // Same pot-home resolution as git-sync (git-sync-action.ts): hive members use
  // their hive_slug, a self_repo hive home uses its own slug.
  const potHomeSlug = entry.hive_slug ?? (entry.self_repo ? entry.slug : undefined);
  if (!potHomeSlug) {
    return { kind: 'origin', reason: `${entry.slug} is not a pot home or member — publishing to origin` };
  }
  const workspaceId = input.workspaceId;
  if (!workspaceId) {
    return {
      kind: 'hold',
      reason: 'integration_mode_unknown',
      message:
        `no workspace id for pot ${potHomeSlug}, so its integration mode cannot be read — holding promotion ` +
        'rather than risking a working-copy pot publishing to the main repository',
    };
  }
  const read = await deps.readMode(workspaceId, potHomeSlug);
  const decision = resolveIntegrationPushRemote({
    read,
    ...(entry.fork_remote ? { forkRemote: entry.fork_remote } : {}),
  });
  if (decision.kind === 'unchanged') return { kind: 'origin', reason: decision.reason };
  if (decision.kind === 'fork') {
    return {
      kind: 'fork',
      remoteName: decision.remoteName,
      url: decision.url,
      potHomeSlug,
      integration: read,
      ...(entry.github_remote ? { upstreamRemote: entry.github_remote } : {}),
      reason: decision.reason,
    };
  }
  if (decision.reason === 'working_copy_fork_missing') {
    return { kind: 'skip', reason: 'working_copy_fork_missing', message: decision.message };
  }
  return { kind: 'hold', reason: decision.reason, message: decision.message };
}

// ─── publishing a promotion ─────────────────────────────────────────────────

/** The owner of a GitHub remote in any form the registry stores (https, ssh, bare "github.com/o/r"). */
export function githubOwnerOf(remote: string): string | null {
  const m = /github\.com[:/]+([A-Za-z0-9][A-Za-z0-9_.-]{0,38})\/[A-Za-z0-9][A-Za-z0-9_.-]*/.exec(remote.trim());
  return m?.[1] ?? null;
}

export type StandingPrRefresh = PublishStandingPrResult | { ok: false; stage: 'setup'; error: string };

export type PromotionPublishOutcome =
  /** Direct mode / unowned checkout: the caller runs its existing origin push. */
  | { kind: 'origin' }
  /** Review mode without a fork: published nowhere; the local gate stays authoritative. */
  | { kind: 'skipped'; message: string }
  /** Review mode: pushed to the working copy; the standing PR refresh is best-effort. */
  | {
      kind: 'fork';
      potHomeSlug: string;
      remoteRef: string;
      standingPr: StandingPrRefresh;
      /** D-017 §5: the standing PR of every submodule whose pin the main repository lacks. */
      submodulePrs?: SubmoduleStandingPr[];
    };

/** One submodule's standing PR, refreshed alongside the superproject's (D-017 §5). */
export interface SubmoduleStandingPr {
  path: string;
  sha: string;
  standingPr: StandingPrRefresh;
}

export interface PublishPromotionInput extends ResolvePromotionPushTargetInput {
  /** The tested commit being promoted. */
  sha: string;
  /** The promoted branch ("main" or "refs/heads/main"); also the standing PR's base branch. */
  ref: string;
}

export interface PublishPromotionDeps extends ResolvePromotionPushTargetDeps {
  /** Make the checkout's `pot-fork` remote point at the fork url. */
  ensureRemote: (repoPath: string, url: string) => Promise<unknown>;
  /** Push `sha` to `remoteRef` on the `pot-fork` remote. Throws on rejection. */
  pushToFork: (repoPath: string, sha: string, remoteRef: string) => Promise<void>;
  /** The GitHub PR host seams; null when no host/token is available. */
  createStandingPrDeps: (repoPath: string) => Promise<StandingPrDeps | null>;
  publishStandingPr?: typeof publishStandingPr;
  /** Correlate admitted fixes only after the host confirms this tested PR head. */
  recordStandingPr?: (input: PublishPromotionInput & {
    potHomeSlug: string; upstreamRemote: string; prNumber: number; prUrl: string;
  }) => Promise<{ linked: string[]; failed: Array<{ workItemId: string; error: string }> }>;
  /** D-017: does the checkout use submodules? Default: {@link repoHasSubmodules}. */
  hasSubmodules?: (repoPath: string) => boolean | undefined;
  /**
   * D-017 §5: the gitlinks in `sha` whose commits their submodule's main repository does
   * not have yet, relative to the main repository's `baseBranch`. Required for a checkout
   * with submodules: without it the promotion is held.
   */
  findUnpublishedGitlinks?: (
    repoPath: string,
    sha: string,
    baseBranch: string,
  ) => Promise<{ ok: true; unpublished: UnpublishedGitlink[] } | { ok: false; error: string }>;
  /** D-017: the pot's recorded fork of each submodule. */
  readSubmoduleForks?: (workspaceId: string, potHomeSlug: string) => Promise<SubmoduleForksRead>;
  /** Push `sha` to `branch` on the submodule's fork (non-force), from its checkout. Throws on rejection. */
  pushSubmoduleHead?: (subDir: string, forkUrl: string, sha: string, branch: string) => Promise<void>;
  log: (line: string) => void;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Publish a promoted commit according to the owning pot's integration mode.
 *
 * - `origin` is returned for the caller to run its existing origin push.
 * - `hold` THROWS, so promotion is held (fail closed — never risk an upstream leak).
 * - A failed fork push THROWS too: same contract as the origin push, a promotion
 *   that could not be published must not advance local `main`.
 * - The standing PR refresh never throws: the working copy's main already carries
 *   the tested commit, and the next promotion (or an on-demand send) retries it.
 */
export async function publishPromotion(
  input: PublishPromotionInput,
  deps: PublishPromotionDeps,
): Promise<PromotionPublishOutcome> {
  const target = await resolvePromotionPushTarget(input, deps);
  if (target.kind === 'origin') return { kind: 'origin' };
  if (target.kind === 'hold') throw new Error(`promotion held (${target.reason}): ${target.message}`);
  if (target.kind === 'skip') {
    deps.log(`git-push: skipped — ${target.message}`);
    return { kind: 'skipped', message: target.message };
  }

  const remoteRef = input.ref.startsWith('refs/') ? input.ref : `refs/heads/${input.ref}`;
  // D-017 §5: every pin the main repositories lack goes to its submodule fork FIRST. A
  // failure throws (promotion held): the superproject must never publish an unreachable gitlink.
  const pins = await publishSubmodulePins(input, target, remoteRef, deps);
  await deps.ensureRemote(input.repoPath, target.url);
  await deps.pushToFork(input.repoPath, input.sha, remoteRef);
  deps.log(
    `git-push: published ${input.sha.slice(0, 12)} to the working copy of ${target.potHomeSlug} ` +
      `(${target.remoteName} ${remoteRef}) — the main repository receives it only through the standing PR`,
  );

  const submodulePrs: SubmoduleStandingPr[] = [];
  for (const pin of pins) {
    const pr = await refreshSubmoduleStandingPr(input, target, pin, deps);
    deps.log(
      pr.ok
        ? `standing-pr (${pin.link.path}): ${pr.decision.action}${'prUrl' in pr && pr.prUrl ? ` ${pr.prUrl}` : ''}`
        : `standing-pr (${pin.link.path}): not refreshed (${pr.stage}) — ${pr.error}`,
    );
    submodulePrs.push({ path: pin.link.path, sha: pin.link.sha, standingPr: pr });
  }
  const relatedPrs: SubmodulePrLink[] = submodulePrs.map((s) => ({
    path: s.path,
    sha: s.sha,
    ...(s.standingPr.ok && 'prUrl' in s.standingPr && s.standingPr.prUrl ? { url: s.standingPr.prUrl } : {}),
  }));

  const standingPr = await refreshStandingPr(input, target, remoteRef, deps, 'promotion', relatedPrs);
  if (standingPr.ok) {
    const pr = 'prUrl' in standingPr && standingPr.prUrl ? ` ${standingPr.prUrl}` : '';
    deps.log(`standing-pr: ${standingPr.decision.action}${pr}`);
  } else {
    deps.log(`standing-pr: not refreshed (${standingPr.stage}) — ${standingPr.error}`);
  }
  return {
    kind: 'fork',
    potHomeSlug: target.potHomeSlug,
    remoteRef,
    standingPr,
    ...(submodulePrs.length ? { submodulePrs } : {}),
  };
}

interface PublishedPin {
  link: UnpublishedGitlink;
  fork: string;
}

/**
 * D-017 §5: push each gitlink the main repositories lack to its submodule fork's standing
 * branch. Returns what was pushed; THROWS (promotion held) when a pin cannot be verified
 * or published, so the superproject PR never names a commit no reachable fork carries.
 */
async function publishSubmodulePins(
  input: PublishPromotionInput,
  target: Extract<PromotionPushTarget, { kind: 'fork' }>,
  remoteRef: string,
  deps: PublishPromotionDeps,
): Promise<PublishedPin[]> {
  if ((deps.hasSubmodules ?? repoHasSubmodules)(input.repoPath) !== true) return [];
  const held = (reason: string, message: string): Error => new Error(`promotion held (${reason}): ${message}`);
  if (!deps.findUnpublishedGitlinks || !deps.readSubmoduleForks || !deps.pushSubmoduleHead) {
    throw held('submodule_publish_unavailable', 'this checkout uses submodules but no submodule publisher is wired');
  }
  const found = await deps.findUnpublishedGitlinks(input.repoPath, input.sha, remoteRef.replace(/^refs\/heads\//, ''));
  if (!found.ok) throw held('submodule_pins_unverifiable', found.error);
  if (found.unpublished.length === 0) return [];
  if (!input.workspaceId) throw held('submodule_forks_unreadable', `no workspace id for pot ${target.potHomeSlug}`);
  const forks = await deps.readSubmoduleForks(input.workspaceId, target.potHomeSlug);
  if (forks.source === 'error' || forks.source === 'malformed') {
    throw held('submodule_forks_unreadable', `the submodule forks of ${target.potHomeSlug} are ${forks.source}`);
  }
  const pins: PublishedPin[] = [];
  for (const link of found.unpublished) {
    const fork = forks.forks[link.path];
    if (!fork) {
      throw held('submodule_fork_missing', `submodule '${link.path}' pins ${link.sha.slice(0, 12)}, but the pot has no fork of it`);
    }
    try {
      await deps.pushSubmoduleHead(join(input.repoPath, link.path), fork, link.sha, STANDING_PR_BRANCH);
    } catch (e) {
      throw held('submodule_publish_failed', `submodule '${link.path}' @ ${link.sha.slice(0, 12)}: ${errText(e)}`);
    }
    deps.log(`git-push: published submodule '${link.path}' @ ${link.sha.slice(0, 12)} to its fork's ${STANDING_PR_BRANCH}`);
    pins.push({ link, fork });
  }
  return pins;
}

/** Open or update one submodule's standing PR (fork standing branch → its main repository). Never throws. */
async function refreshSubmoduleStandingPr(
  input: PublishPromotionInput,
  target: Extract<PromotionPushTarget, { kind: 'fork' }>,
  pin: PublishedPin,
  deps: PublishPromotionDeps,
): Promise<StandingPrRefresh> {
  const forkOwner = githubOwnerOf(pin.fork);
  const upstreamOwner = githubOwnerOf(pin.link.url);
  if (!forkOwner || !upstreamOwner) {
    return { ok: false, stage: 'setup', error: `not a GitHub remote pair: fork ${pin.fork}, main ${pin.link.url || '(unknown)'}` };
  }
  const subDir = join(input.repoPath, pin.link.path);
  let prDeps: StandingPrDeps | null;
  try {
    prDeps = await deps.createStandingPrDeps(subDir);
  } catch (e) {
    return { ok: false, stage: 'setup', error: `PR host unavailable: ${errText(e)}` };
  }
  if (!prDeps) return { ok: false, stage: 'setup', error: 'no GitHub PR host available (missing token)' };
  try {
    return await (deps.publishStandingPr ?? publishStandingPr)(
      {
        integration: target.integration,
        forkRemote: pin.fork,
        forkOwner,
        upstreamRemote: pin.link.url,
        upstreamOwner,
        baseBranch: pin.link.branch,
        promotedSha: pin.link.sha,
        trigger: 'promotion',
        potName: `${target.potHomeSlug} (${pin.link.path})`,
      },
      prDeps,
    );
  } catch (e) {
    return { ok: false, stage: 'setup', error: errText(e) };
  }
}

async function refreshStandingPr(
  input: PublishPromotionInput,
  target: Extract<PromotionPushTarget, { kind: 'fork' }>,
  remoteRef: string,
  deps: PublishPromotionDeps,
  trigger: 'promotion' | 'on-demand',
  relatedPrs: readonly SubmodulePrLink[] = [],
): Promise<StandingPrRefresh> {
  const upstream = target.upstreamRemote;
  if (!upstream) {
    return { ok: false, stage: 'setup', error: `pot ${target.potHomeSlug} has no main-repository remote (github_remote)` };
  }
  const forkOwner = githubOwnerOf(target.url);
  const upstreamOwner = githubOwnerOf(upstream);
  if (!forkOwner || !upstreamOwner) {
    return { ok: false, stage: 'setup', error: `not a GitHub remote pair: fork ${target.url}, main ${upstream}` };
  }
  let prDeps: StandingPrDeps | null;
  try {
    prDeps = await deps.createStandingPrDeps(input.repoPath);
  } catch (e) {
    return { ok: false, stage: 'setup', error: `PR host unavailable: ${errText(e)}` };
  }
  if (!prDeps) return { ok: false, stage: 'setup', error: 'no GitHub PR host available (missing token)' };
  try {
    const result = await (deps.publishStandingPr ?? publishStandingPr)(
      {
        integration: target.integration,
        forkRemote: target.url,
        forkOwner,
        upstreamRemote: upstream,
        upstreamOwner,
        baseBranch: remoteRef.replace(/^refs\/heads\//, ''),
        promotedSha: input.sha,
        trigger,
        potName: target.potHomeSlug,
        ...(relatedPrs.length ? { relatedPrs } : {}),
      },
      prDeps,
    );
    if (result.ok && result.prNumber && result.prUrl && deps.recordStandingPr) {
      try {
        const linked = await deps.recordStandingPr({
          ...input, potHomeSlug: target.potHomeSlug, upstreamRemote: upstream,
          prNumber: result.prNumber, prUrl: result.prUrl,
        });
        if (linked.linked.length) deps.log(`standing-pr: linked ${linked.linked.join(', ')} to ${result.prUrl}`);
        for (const failure of linked.failed) deps.log(`standing-pr: source linkage pending for ${failure.workItemId}: ${failure.error}`);
      } catch (error) {
        // The PR exists even when source bookkeeping fails. A subsequent refresh
        // retries linkage without opening another PR or claiming false completion.
        deps.log(`standing-pr: source linkage pending: ${errText(error)}`);
      }
    }
    return result;
  } catch (e) {
    return { ok: false, stage: 'setup', error: errText(e) };
  }
}

export type SendStandingPrNowOutcome =
  /** Direct mode, no fork, or an unreadable mode: there is no standing PR to send. */
  | { kind: 'not-review'; message: string }
  /** Review mode, but the working copy holds no gate-promoted commit yet. */
  | { kind: 'nothing-green'; message: string }
  | { kind: 'sent'; potHomeSlug: string; sha: string; standingPr: StandingPrRefresh };

export interface SendStandingPrNowDeps extends PublishPromotionDeps {
  /** The sha the working copy's `remoteRef` holds; null when the ref does not exist. */
  readForkHead: (repoPath: string, remoteRef: string) => Promise<string | null>;
}

/**
 * On-demand "send what's green now" (P-020): open or update the standing PR from the
 * working copy's main without waiting for the next promotion. It never pushes code: the
 * working copy's main holds only commits the pot's green gate already promoted (D-007),
 * so this can only send tested work.
 */
export async function sendStandingPrNow(
  input: ResolvePromotionPushTargetInput & { ref: string },
  deps: SendStandingPrNowDeps,
): Promise<SendStandingPrNowOutcome> {
  const target = await resolvePromotionPushTarget(input, deps);
  if (target.kind === 'origin') {
    return { kind: 'not-review', message: 'this pot commits straight to the main repository; there is no standing PR' };
  }
  if (target.kind !== 'fork') return { kind: 'not-review', message: target.message };
  const remoteRef = input.ref.startsWith('refs/') ? input.ref : `refs/heads/${input.ref}`;
  await deps.ensureRemote(input.repoPath, target.url);
  const sha = await deps.readForkHead(input.repoPath, remoteRef);
  if (!sha) {
    return { kind: 'nothing-green', message: `the working copy has no ${remoteRef} yet: nothing has passed the gate` };
  }
  const standingPr = await refreshStandingPr({ ...input, sha }, target, remoteRef, deps, 'on-demand');
  return { kind: 'sent', potHomeSlug: target.potHomeSlug, sha, standingPr };
}

/** The real seams for {@link sendStandingPrNow}. */
export async function createDefaultSendStandingPrNowDeps(log: (line: string) => void): Promise<SendStandingPrNowDeps> {
  const base = await createDefaultPublishPromotionDeps(log);
  return {
    ...base,
    readForkHead: async (repoPath, remoteRef) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { stdout } = await promisify(execFile)('git', ['-C', repoPath, 'ls-remote', POT_FORK_REMOTE_NAME, remoteRef]);
      const sha = stdout.trim().split(/\s+/)[0];
      return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    },
  };
}

/** Code-returning git (never throws), for the submodule seams. */
async function execGitCode(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  try {
    const { stdout, stderr } = await promisify(execFile)('git', args, { cwd, encoding: 'utf8' });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string; message?: string };
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '' };
  }
}

/** The real seams for {@link publishPromotion}; `log` is the green-checkpoint logger. */
export async function createDefaultPublishPromotionDeps(log: (line: string) => void): Promise<PublishPromotionDeps> {
  const [{ loadHarnessRegistry }, mode, standing, { redactToken }] = await Promise.all([
    import('../../harness-registry'),
    import('./pot-integration-mode'),
    import('./standing-pr'),
    import('../clone-url'),
  ]);
  return {
    loadProjects: async (ws) => (await loadHarnessRegistry(ws)).projects,
    readMode: (ws, slug) => mode.readPotIntegrationMode(ws, slug),
    ensureRemote: (repoPath, url) => mode.ensurePotForkGitRemote(repoPath, url),
    pushToFork: async (repoPath, sha, remoteRef) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      try {
        await promisify(execFile)('git', ['-C', repoPath, 'push', POT_FORK_REMOTE_NAME, `${sha}:${remoteRef}`], {
          // green-checkpoint is the one sanctioned writer of `main` (bin/git-hooks/pre-push).
          env: { ...process.env, PAPERCUSP_MAIN_PUSH_OK: '1' },
        });
      } catch (e) {
        throw new Error(redactToken(`push to the working copy failed: ${errText(e)}`));
      }
    },
    createStandingPrDeps: (repoPath) => standing.createDefaultStandingPrDeps({ repoPath }),
    // D-017 §5: in a working copy `origin` is the main repository; its target branch is
    // fetched fresh so "published" is judged against what the PR actually merges into.
    findUnpublishedGitlinks: async (repoPath, sha, baseBranch) => {
      const fetched = await execGitCode(
        // Superproject refs only: recursing would fetch submodule pins and fail on unpublished ones.
        ['fetch', '--no-tags', '--no-recurse-submodules', 'origin', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`],
        repoPath,
      );
      if (fetched.code !== 0) {
        return { ok: false, error: redactToken(`could not fetch the main repository's ${baseBranch}: ${fetched.stderr.trim().slice(0, 200)}`) };
      }
      const { findUnpublishedGitlinks } = await import('./submodule-forks');
      return findUnpublishedGitlinks({ repoDir: repoPath, commit: sha, baseCommit: `refs/remotes/origin/${baseBranch}`, runGit: execGitCode });
    },
    readSubmoduleForks: async (ws, slug) => (await import('./submodule-forks')).readSubmoduleForks(ws, slug),
    pushSubmoduleHead: async (subDir, forkUrl, sha, branch) => {
      await mode.ensurePotForkGitRemote(subDir, forkUrl);
      const pushed = await execGitCode(['push', POT_FORK_REMOTE_NAME, `${sha}:refs/heads/${branch}`], subDir);
      if (pushed.code !== 0) throw new Error(redactToken(pushed.stderr.trim() || pushed.stdout.trim() || `git push exited ${pushed.code}`));
    },
    recordStandingPr: async (input) => {
      if (!input.workspaceId) throw new Error('missing workspace for admitted fix linkage');
      const [{ createGitHubPrHost }, { correlateAdmissionStandingPr }, { getOrgPg }] = await Promise.all([
        import('../../pr-host/github'), import('../../work-admission/lifecycle'), import('@papercusp/db-org'),
      ]);
      const host = await createGitHubPrHost();
      if (!host?.getPrDetails) throw new Error('PR host cannot verify the current head and target');
      const read = await host.getPrDetails({ remote: input.upstreamRemote, number: input.prNumber });
      if (!read.ok) throw new Error(read.error.message);
      if (read.data.pr.state !== 'open' || read.data.pr.head_sha !== input.sha
        || read.data.pr.url !== input.prUrl) throw new Error('standing PR moved after the tested publication; linkage deferred');
      const projects = (await loadHarnessRegistry(input.workspaceId)).projects;
      const harnesses = projects.filter((project) => project.slug === input.potHomeSlug
        || project.hive_slug === input.potHomeSlug).map((project) => project.slug);
      return correlateAdmissionStandingPr(getOrgPg().sql, {
        workspaceId: input.workspaceId, harnesses, repositoryRoot: input.repoPath,
        testedSha: input.sha, targetSha: read.data.targetSha, url: input.prUrl, number: input.prNumber,
      });
    },
    log,
  };
}
