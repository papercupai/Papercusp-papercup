/**
 * Local-git facts the PR pane reads, served from a precomputed snapshot so that no
 * sync-resolver read path spawns git (WI-6554700010030747; the WI-5460 class that
 * sync-resolver/no-heavy-io-on-read-path.test.ts guards).
 *
 * harnessPrs.byHarness and harnessPrs.detail used to shell out on every read:
 *   - `git config --get remote.origin.url`: the remote fallback for a project whose
 *     metadata has no `remote` (prs.ts resolveHarnessPrRemote);
 *   - `git rev-parse refs/heads/main`: the promoted commit the standing-PR merge
 *     gate compares against (pr-viewer.ts mergeEvidence).
 * The `harnessPrs.gitFacts` producer in derived-reads/producers.ts now runs both per
 * harness through ./pr-git-facts-compute, on the precompute routine where nobody is
 * waiting. Readers call readHarnessPrGitFacts, a snapshot SELECT that never computes.
 *
 * This module must stay free of node:child_process; the subprocess half lives in
 * ./pr-git-facts-compute and is loaded only by the producer.
 *
 * A miss returns null (never computed yet, or a superseded producerVersion). That
 * read warms the key in the background, and the snapshot write invalidates every
 * resolver listing harness_shared.derived_read_snapshots in its backingTables, so an
 * open PR pane re-reads once the facts exist.
 */
export const HARNESS_PR_GIT_FACTS_KEY = 'harnessPrs.gitFacts';

export interface HarnessPrGitFacts {
  /** `github.com/<owner>/<repo>` from the checkout's origin; null when it is not a GitHub clone. */
  originRemote: string | null;
  /** The commit at refs/heads/main in the harness checkout; null when there is none. */
  promotedSha: string | null;
}

/** The latest snapshot for one harness, or null when none has been computed yet. */
export async function readHarnessPrGitFacts(harnessSlug: string): Promise<HarnessPrGitFacts | null> {
  const { readDerivedSnapshot } = await import('../derived-reads/registry');
  await import('../derived-reads/producers'); // side effect: registers the producer
  const { payload } = await readDerivedSnapshot<HarnessPrGitFacts>(HARNESS_PR_GIT_FACTS_KEY, { harnessSlug });
  return payload;
}
