/**
 * gitlinks.ts — pure helpers for reading submodule pins (gitlinks) out of git output.
 *
 * Shared by the working-copy submodule support (plan
 * slack-asana-reproduced-bug-fix-pr-workflow-2026-10-08 P-014, decision D-017):
 * `submodule-forks.ts` asks which gitlinks no main repository has received yet, and
 * `sync-back.ts` asks which gitlinks the main repository moved. Kept free of any I/O
 * or settings import so both can use it without pulling in the database layer.
 */

export interface GitlinkRef {
  /** Repository-relative path of the submodule. */
  path: string;
  /** The commit the gitlink pins. */
  sha: string;
}

/** PURE: parse `git diff --raw --no-abbrev` lines whose NEW side is a gitlink. */
export function parseGitlinkDiff(stdout: string): Array<GitlinkRef & { oldSha: string | null }> {
  const out: Array<GitlinkRef & { oldSha: string | null }> = [];
  for (const line of stdout.split('\n')) {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) [A-Z]\d*\t(.+)$/.exec(line);
    if (!m || m[2] !== '160000') continue;
    out.push({ path: m[5]!, sha: m[4]!, oldSha: m[1] === '160000' && !/^0+$/.test(m[3]!) ? m[3]! : null });
  }
  return out;
}

/** One unmerged index entry, from `git ls-files -u -z`. */
export interface UnmergedEntry {
  mode: string;
  sha: string;
  stage: number;
  path: string;
}

/** PURE: parse `git ls-files -u -z` (`<mode> <sha> <stage>\t<path>\0`…). */
export function parseUnmergedEntries(stdout: string): UnmergedEntry[] {
  const out: UnmergedEntry[] = [];
  for (const rec of stdout.split('\0')) {
    const m = /^(\d{6}) ([0-9a-f]{40,64}) ([0-3])\t(.+)$/.exec(rec);
    if (m) out.push({ mode: m[1]!, sha: m[2]!, stage: Number(m[3]), path: m[4]! });
  }
  return out;
}
