/**
 * ensure-fork — ensures the authenticated GitHub user has a fork of the
 * upstream shared-harness repo, ready to receive a pushed feature branch.
 *
 * Part of the non-collaborator code→PR path (non-collaborator-join-fork-pr
 * sub-project B, D1): a contributor without write access to the upstream repo
 * pushes their feature branch to THEIR OWN fork and opens a cross-fork PR. This
 * module guarantees the fork exists and is ready before the push.
 *
 * Why a ready-poll: `POST /repos/{owner}/{repo}/forks` is asynchronous — GitHub
 * returns 202 immediately but the fork repo may not be queryable for a few
 * seconds. We poll `repos.get(forkOwner, repo)` until it answers 200 (or the
 * deadline elapses) so the caller can safely push right after.
 *
 * Idempotent: if the fork already exists it returns `{ created: false }` without
 * calling createFork. If the authenticated user IS the upstream owner (the
 * owner/collaborator case), no fork is needed — it short-circuits to the
 * upstream repo itself.
 *
 * Injectable Octokit (`opts.octokit`) for tests; defaults to `getOctokit()`.
 */

import { getOctokit } from '../identity/octokit-client';
import type { Octokit } from '@octokit/rest';

export interface EnsureForkOpts {
  /** Owner of the upstream shared repo (e.g. "papercupai"). */
  upstreamOwner: string;
  /** Name of the upstream shared repo (e.g. "papercup"). */
  upstreamRepo: string;
  /**
   * Injectable Octokit for tests (avoids gh-token resolution). Typed `unknown`
   * so callers don't import `@octokit/rest`; cast internally.
   */
  octokit?: unknown;
  /** Poll interval while waiting for the fork to become ready. Default 1000ms. */
  pollIntervalMs?: number;
  /** Max wall-clock to wait for the fork to become ready. Default 30000ms. */
  maxWaitMs?: number;
  /** Injectable sleep (tests pass an instant no-op). Default real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export interface EnsureForkResult {
  /** GitHub login that owns the fork (the authenticated user) — or the upstream
   *  owner when the authed user already owns the upstream (no fork needed). */
  forkOwner: string;
  /** "<forkOwner>/<repo>" — the full name to use as a git remote / PR head. */
  forkFullName: string;
  /** True when a fork was created this call; false when it pre-existed or no
   *  fork was needed (authed user owns the upstream). */
  created: boolean;
}

/**
 * Ensure the authenticated user has a ready fork of `upstreamOwner/upstreamRepo`.
 */
export async function ensureFork(opts: EnsureForkOpts): Promise<EnsureForkResult> {
  const octokit = (opts.octokit as Octokit | undefined) ?? (await getOctokit());
  if (!octokit) {
    throw new Error(
      'ensureFork: no Octokit instance available — inject opts.octokit or run `gh auth login`.',
    );
  }
  const oc = octokit as Octokit;
  const { upstreamOwner, upstreamRepo } = opts;
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const maxWaitMs = opts.maxWaitMs ?? 30_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  // Resolve the authenticated user's login — this is the fork owner.
  const { data: me } = await oc.rest.users.getAuthenticated();
  const forkOwner = me.login;

  // Short-circuit: the authed user already owns the upstream repo (owner /
  // collaborator-with-write case). No fork is needed; use the upstream directly.
  if (forkOwner.toLowerCase() === upstreamOwner.toLowerCase()) {
    return {
      forkOwner,
      forkFullName: `${upstreamOwner}/${upstreamRepo}`,
      created: false,
    };
  }

  // GitHub keeps redirects after a repository transfer. A 200 at the old user
  // name can resolve to the upstream itself, or to an unrelated same-name repo.
  // Reuse only the actual requested fork in this upstream's network.
  const upstreamFullName = `${upstreamOwner}/${upstreamRepo}`;
  let forkRepo = upstreamRepo;
  let existing = await tryGetRepo(oc, forkOwner, forkRepo);
  if (existing && !isMatchingFork(existing, `${forkOwner}/${forkRepo}`, upstreamFullName)) {
    // Keep the occupied/redirected name intact. This stable alternate is shared
    // by subsequent calls, including the submodule working-copy setup.
    forkRepo = `${upstreamOwner}-${upstreamRepo}`.slice(0, 100);
    existing = await tryGetRepo(oc, forkOwner, forkRepo);
    if (existing && !isMatchingFork(existing, `${forkOwner}/${forkRepo}`, upstreamFullName)) {
      throw new Error(`ensureFork: ${forkOwner}/${forkRepo} already resolves to an incompatible repository`);
    }
  }
  if (existing) {
    return { forkOwner, forkFullName: existing.full_name, created: false };
  }

  // Create the fork (async on GitHub's side — 202).
  await oc.rest.repos.createFork({ owner: upstreamOwner, repo: upstreamRepo,
    ...(forkRepo !== upstreamRepo ? { name: forkRepo } : {}) });

  // Poll until the fork repo is queryable (ready) or the deadline elapses.
  const deadline = Date.now() + maxWaitMs;
  // First check immediately, then sleep between subsequent checks.
  for (;;) {
    const ready = await tryGetRepo(oc, forkOwner, forkRepo);
    if (ready && isMatchingFork(ready, `${forkOwner}/${forkRepo}`, upstreamFullName)) {
      return { forkOwner, forkFullName: ready.full_name, created: true };
    }
    if (Date.now() + pollIntervalMs > deadline) {
      throw new Error(
        `ensureFork: fork ${forkOwner}/${forkRepo} not ready within ${maxWaitMs}ms`,
      );
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * `repos.get` that returns the repo data on 200 or `null` on 404; rethrows any
 * other error (auth, rate-limit, 5xx) so the caller surfaces it.
 */
interface ForkRepository {
  full_name: string;
  fork: boolean;
  parent?: { full_name: string };
  source?: { full_name: string };
}

function isMatchingFork(repo: ForkRepository, expectedFullName: string, upstreamFullName: string): boolean {
  const upstream = upstreamFullName.toLowerCase();
  return repo.full_name.toLowerCase() === expectedFullName.toLowerCase() && repo.fork === true
    && [repo.parent?.full_name, repo.source?.full_name].some(name => name?.toLowerCase() === upstream);
}

async function tryGetRepo(
  oc: Octokit,
  owner: string,
  repo: string,
): Promise<ForkRepository | null> {
  try {
    const { data } = await oc.rest.repos.get({ owner, repo });
    return { full_name: data.full_name, fork: data.fork, parent: data.parent, source: data.source };
  } catch (err: unknown) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}
