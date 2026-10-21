/**
 * WI-6554700010019060 — before the suite runs, check that the green candidate could
 * actually be PUBLISHED: origin/<releaseRef> must be an ancestor of the candidate.
 *
 * The promotion push (`git push origin <candidate>:refs/heads/<releaseRef>`, no force)
 * is only a fast-forward when the remote release ref is already in the candidate's
 * history. On 2026-10-21 a second pot pushed a drill-clone commit (b1f1d0cd) onto
 * GitHub Papercusp/papercup `main` that canonical staging never had. Every candidate
 * cut from staging was then unpublishable, and the gate only learned that at the push,
 * after a 1-3h suite (WI-6554700010018725).
 *
 * This check costs one `ls-remote` (plus one ref fetch when the remote sha is not
 * present locally). It refuses only on a MEASURED divergence. Every probe failure
 * (network, missing object, odd exit code) is "unknown" and the gate keeps judging,
 * because a broken preflight must never wedge the gate. The push stays the final
 * authority either way.
 */

export type PromotionTargetAncestryStatus =
  /** origin/<ref> is the candidate or one of its ancestors: the push is a fast-forward. */
  | "ancestor"
  /** origin/<ref> exists and is NOT in the candidate's history: the push will be refused. */
  | "diverged"
  /** origin has no such ref yet: the push creates it. */
  | "absent"
  /** The probe could not answer (network, missing object, unexpected exit). */
  | "unknown";

export interface PromotionTargetAncestryResult {
  /** False only for a measured `diverged`. */
  ok: boolean;
  status: PromotionTargetAncestryStatus;
  remoteSha: string | null;
  summary: string;
}

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `git <argv>` in the integration checkout. Must not throw on a non-zero exit. */
export type PromotionAncestryGit = (argv: string[]) => Promise<GitRunResult>;

export interface CheckPromotionTargetAncestryInput {
  /** The release ref the promotion pushes (`main`, or a full `refs/heads/...`). */
  ref: string;
  /** The sha the promotion would push. */
  candidate: string;
  /** Remote name; defaults to `origin`, the remote the promotion push uses. */
  remote?: string;
}

const SHA_RE = /^[0-9a-f]{40}$/;

function short(sha: string | null): string {
  return sha ? sha.slice(0, 12) : "unset";
}

function tail(text: string): string {
  return text.trim().split(/\r?\n/).slice(-3).join(" | ").slice(0, 400);
}

export async function checkPromotionTargetAncestry(
  input: CheckPromotionTargetAncestryInput,
  git: PromotionAncestryGit,
): Promise<PromotionTargetAncestryResult> {
  const remote = input.remote ?? "origin";
  const remoteRef = input.ref.startsWith("refs/") ? input.ref : `refs/heads/${input.ref}`;
  const label = `${remote}/${input.ref.replace(/^refs\/heads\//, "")}`;
  const unknown = (why: string, remoteSha: string | null = null): PromotionTargetAncestryResult => ({
    ok: true,
    status: "unknown",
    remoteSha,
    summary: `promotion-target preflight: could not check ${label} (${why}); judging anyway, the push stays the final check`,
  });

  let listed: GitRunResult;
  try {
    listed = await git(["ls-remote", remote, remoteRef]);
  } catch (e) {
    return unknown(`ls-remote threw: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (listed.code !== 0) return unknown(`ls-remote exited ${listed.code}: ${tail(listed.stderr || listed.stdout)}`);

  const line = listed.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.endsWith(`\t${remoteRef}`) || l.endsWith(` ${remoteRef}`));
  if (!line) {
    return {
      ok: true,
      status: "absent",
      remoteSha: null,
      summary: `promotion-target preflight: ${label} does not exist yet; the promotion push creates it`,
    };
  }
  const remoteSha = line.split(/\s+/)[0] ?? "";
  if (!SHA_RE.test(remoteSha)) return unknown(`unparseable ls-remote line "${line.slice(0, 120)}"`);

  const ancestor: PromotionTargetAncestryResult = {
    ok: true,
    status: "ancestor",
    remoteSha,
    summary: `promotion-target preflight: ${label} ${short(remoteSha)} is an ancestor of candidate ${short(input.candidate)}; the promotion push is a fast-forward`,
  };
  if (remoteSha === input.candidate) return ancestor;

  const has = async (): Promise<boolean> => {
    try {
      return (await git(["cat-file", "-e", `${remoteSha}^{commit}`])).code === 0;
    } catch {
      return false;
    }
  };
  if (!(await has())) {
    // Fetch only the release ref, into no local ref: the object is all the check needs.
    try {
      await git(["fetch", "--no-tags", "--quiet", remote, remoteRef]);
    } catch {
      // The second `has()` decides.
    }
    if (!(await has())) return unknown(`remote sha ${short(remoteSha)} is not available locally after fetching ${remoteRef}`, remoteSha);
  }

  let verdict: GitRunResult;
  try {
    verdict = await git(["merge-base", "--is-ancestor", remoteSha, input.candidate]);
  } catch (e) {
    return unknown(`merge-base threw: ${e instanceof Error ? e.message : String(e)}`, remoteSha);
  }
  if (verdict.code === 0) return ancestor;
  if (verdict.code !== 1) return unknown(`merge-base exited ${verdict.code}: ${tail(verdict.stderr)}`, remoteSha);

  return {
    ok: false,
    status: "diverged",
    remoteSha,
    summary:
      `promotion-target preflight REFUSED: ${label} is at ${short(remoteSha)}, which is NOT in the history of ` +
      `candidate ${short(input.candidate)}. The promotion push is a plain fast-forward, so a green verdict here ` +
      `could never be published. No suite was run and NO verdict is rendered; this is not a code red.\n` +
      `Something outside this gate moved ${label} (WI-6554700010018725: a second pot pushed its own commit there). ` +
      `REMEDY: find who pushed ${short(remoteSha)} (\`gh api repos/<owner>/<repo>/activity?ref=${remoteRef}\`), ` +
      `then either restore ${label} to the last promoted sha with a lease-pinned force push, or merge ${short(remoteSha)} ` +
      `into the integration branch if it belongs there. The condition does not clear by re-running the gate.`,
  };
}
