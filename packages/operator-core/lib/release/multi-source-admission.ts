/**
 * change-provenance-and-admission-throughput-2026-10-27#P-002 (R-2): MULTI-SOURCE admission.
 *
 * One `release:repair-queue admit` used to take exactly one source mode: hunk-exact, whole-blob
 * OR committed patch. A leader landing several members' ready batches (some as staging's whole
 * blob, some as a reviewed committed delta, e.g. a cohort-drag test file whose fix sits in one
 * commit) therefore paid one admission, one built commit and one R6 pre-check PER MODE, and the
 * pre-check slot is single-file: six batches queued behind it (measured, see the plan's R-2).
 *
 * This module turns an ORDERED list of sources into ONE synthesized source commit on repairHead.
 * The admit door then builds its single admission commit from that source exactly as it does for
 * one mode (same path proof, same import preflight, same lineage CAS, ONE pre-check):
 *
 *   head₀ = repairHead
 *   whole-blob source i   → headᵢ₊₁ = headᵢ with each named path's entry taken from the source
 *                            commit (pinned `sourceCommit`, else the integration tip read ONCE)
 *   committed-patch src i → headᵢ₊₁ = each reviewed delta replayed onto headᵢ, oldest first
 *                            (`buildCommittedPatchSource`, unchanged)
 *
 * Nothing here publishes a ref or touches a worktree or the real index; every intermediate
 * object is unreachable until the door publishes the single built commit. A refused source
 * therefore refuses the WHOLE call: no source is ever admitted partially.
 *
 * Order is the caller's. Two rules keep "applied in order" from silently dropping a source:
 *  - a whole-blob source may not name a path an EARLIER source already named — its blob would
 *    overwrite that source's change, discarding it without a trace;
 *  - a committed-patch source MAY follow another source on the same path: its delta replays on
 *    top of the earlier result (or refuses `patch-conflict` if it does not apply).
 *
 * The cohort half of the import/cohort check (D-045) needs the REAL whole-blob source commits,
 * not the synthesized one (whose diff against repairHead is just the admitted paths), so the
 * result names them, each with the paths copied from it, in `cohortSources`; the door passes them
 * to the preflight, which checks each against the COMBINED admitted set — a test dragged by one
 * whole-blob source is satisfied when another source in the same call admits it, and a module
 * another source admitted never counts as copied from this one.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMISSION_GIT_DATE } from './admission-commit-date';
import { buildCommittedPatchSource } from './hunk-exact-admission';
import {
  ADMISSION_GIT_IDENTITY,
  normalizeAdmissionPath,
  realAdmissionGit,
  type AdmissionGitResult,
  type AdmissionGitRunner,
} from './repair-head-admission';

const FULL_SHA_RE = /^[0-9a-f]{40,64}$/;
/** Matches the single-mode door's patchCommits cap. */
export const MAX_ADMISSION_SOURCES = 20;
export const MAX_PATCH_COMMITS_PER_SOURCE = 20;

/** One source as the caller writes it — the same field names as the single-mode admit args. */
export type AdmissionSourceArg =
  | { paths: string[]; wholeBlob: true; sourceCommit?: string }
  | { paths: string[]; patchCommit: string }
  | { paths: string[]; patchCommits: string[] };

export type NormalizedAdmissionSource =
  | { index: number; kind: 'whole-blob'; paths: string[]; sourceCommit?: string }
  | { index: number; kind: 'committed-patch'; paths: string[]; commits: string[] };

export interface AdmissionSourcesRefusal {
  ok: false;
  code: 'invalid-sources';
  /** Zero-based index into the caller's `sources`, when one source is at fault. */
  sourceIndex?: number;
  detail: string;
}

/**
 * Validate and normalize the caller's `sources`. Pure: no git. The returned `paths` is the union
 * in first-appearance order — exactly the path set the door's single admission commit carries.
 */
export function normalizeAdmissionSources(
  raw: unknown,
): { ok: true; sources: NormalizedAdmissionSource[]; paths: string[] } | AdmissionSourcesRefusal {
  const refuse = (detail: string, sourceIndex?: number): AdmissionSourcesRefusal =>
    ({ ok: false, code: 'invalid-sources', detail, ...(sourceIndex !== undefined ? { sourceIndex } : {}) });
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ADMISSION_SOURCES) {
    return refuse(`sources must be a list of 1–${MAX_ADMISSION_SOURCES} entries`);
  }
  const sources: NormalizedAdmissionSource[] = [];
  const union: string[] = [];
  const named = new Set<string>();
  for (let index = 0; index < raw.length; index++) {
    const entry = raw[index] as Record<string, unknown> | null;
    if (!entry || typeof entry !== 'object') return refuse('each source must be an object', index);
    const modes = [entry.wholeBlob === true, entry.patchCommit !== undefined, entry.patchCommits !== undefined].filter(Boolean).length;
    if (modes !== 1) {
      return refuse('each source names exactly one mode: wholeBlob:true, patchCommit, or patchCommits', index);
    }
    if (entry.sourceCommit !== undefined && entry.wholeBlob !== true) {
      return refuse('sourceCommit is only valid on a wholeBlob source', index);
    }
    if (!Array.isArray(entry.paths) || entry.paths.length < 1) return refuse('each source names at least one path', index);
    const paths: string[] = [];
    for (const p of entry.paths) {
      const normalized = typeof p === 'string' ? normalizeAdmissionPath(p) : null;
      if (normalized === null) return refuse(`not a normal repository-relative path: ${JSON.stringify(p)}`, index);
      if (!paths.includes(normalized)) paths.push(normalized);
    }
    if (entry.wholeBlob === true) {
      const overwritten = paths.filter((p) => named.has(p));
      if (overwritten.length > 0) {
        return refuse(
          `whole-blob source #${index} names ${overwritten.join(', ')}, which an earlier source already changes — ` +
            "its blob would silently discard that source's change. Put the whole-blob source first, or drop the path from one of them.",
          index,
        );
      }
      if (entry.sourceCommit !== undefined && (typeof entry.sourceCommit !== 'string' || !FULL_SHA_RE.test(entry.sourceCommit))) {
        return refuse('sourceCommit must be a full commit SHA', index);
      }
      sources.push({
        index,
        kind: 'whole-blob',
        paths,
        ...(typeof entry.sourceCommit === 'string' ? { sourceCommit: entry.sourceCommit } : {}),
      });
    } else {
      const commits = entry.patchCommits !== undefined ? entry.patchCommits : [entry.patchCommit];
      if (
        !Array.isArray(commits) ||
        commits.length < 1 ||
        commits.length > MAX_PATCH_COMMITS_PER_SOURCE ||
        commits.some((sha) => typeof sha !== 'string' || !FULL_SHA_RE.test(sha)) ||
        new Set(commits).size !== commits.length
      ) {
        return refuse(`a patch source names 1–${MAX_PATCH_COMMITS_PER_SOURCE} distinct full commit SHAs`, index);
      }
      sources.push({ index, kind: 'committed-patch', paths, commits: commits as string[] });
    }
    for (const p of paths) {
      named.add(p);
      if (!union.includes(p)) union.push(p);
    }
  }
  return { ok: true, sources, paths: union };
}

/** What each source contributed, in application order — recorded on the admission entry. */
export type AppliedAdmissionSource =
  | { index: number; kind: 'whole-blob'; paths: string[]; sourceCommit: string; pinned: boolean; headAfter: string }
  | {
      index: number;
      kind: 'committed-patch';
      paths: string[];
      patches: Array<{ commit: string; parent: string; sha256: string }>;
      headAfter: string;
    };

export interface MultiSourceSuccess {
  ok: true;
  /** The synthesized source commit: repairHead plus every source, applied in order. */
  sourceCommit: string;
  tree: string;
  /** Union of every source's paths, first-appearance order — the single admission's path set. */
  paths: string[];
  applied: AppliedAdmissionSource[];
  /** Every committed delta replayed, in order, across all patch sources. */
  patches: Array<{ commit: string; parent: string; sha256: string }>;
  /**
   * One entry per distinct whole-blob source commit, with the paths copied from it. The D-045
   * cohort check runs once per entry: `paths` is the "admitted from this source" side, while the
   * whole admission's path set decides what is already admitted.
   */
  cohortSources: Array<{ sourceCommit: string; paths: string[] }>;
  /** The integration tip every unpinned whole-blob source read (pinned once per call). */
  integrationTip: string;
}

export interface MultiSourceRefusal {
  ok: false;
  code: string;
  sourceIndex?: number;
  path?: string;
  detail: string;
}

/**
 * Apply `sources` in order onto `repairHead`, producing one unpublished source commit.
 * All-or-nothing: the first refused source refuses the call.
 */
export function buildMultiSourceAdmissionSource(input: {
  root: string;
  repairHead: string;
  integrationRef: string;
  sources: readonly NormalizedAdmissionSource[];
  reason: string;
  git?: AdmissionGitRunner;
}): MultiSourceSuccess | MultiSourceRefusal {
  const git = input.git ?? realAdmissionGit;
  const run = (args: string[], env?: NodeJS.ProcessEnv) =>
    git(args, { cwd: input.root, env: { ...process.env, GIT_LITERAL_PATHSPECS: '1', ...env } });
  const failed = (step: string, r: AdmissionGitResult, sourceIndex?: number): MultiSourceRefusal => ({
    ok: false,
    code: 'git-failed',
    ...(sourceIndex !== undefined ? { sourceIndex } : {}),
    detail: `${step} exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`,
  });
  if (input.reason.trim().length < 8) {
    return {
      ok: false,
      code: 'reason_required',
      detail:
        'a multi-source admission carries whole-blob and/or reviewed committed-patch sources — say why each is safe in `reason` (≥ 8 chars)',
    };
  }
  if (input.sources.length < 1) return { ok: false, code: 'invalid-sources', detail: 'no sources given' };
  const resolve = (ref: string) => {
    const r = run(['rev-parse', '--verify', `${ref}^{commit}`]);
    const sha = r.stdout.trim();
    return r.status === 0 && FULL_SHA_RE.test(sha) ? { ok: true as const, sha } : { ok: false as const, r };
  };
  const head0 = resolve(input.repairHead);
  if (!head0.ok) return failed('resolve repair head', head0.r);
  // Pin the integration tip ONCE, so every unpinned whole-blob source reads the same tree even
  // while git-sync advances the branch mid-call.
  const tip = resolve(input.integrationRef);
  if (!tip.ok) return failed('pin integration tip', tip.r);

  let head = head0.sha;
  const applied: AppliedAdmissionSource[] = [];
  const patches: MultiSourceSuccess['patches'] = [];
  const cohort: Array<{ sourceCommit: string; paths: string[] }> = [];
  const identityEnv: NodeJS.ProcessEnv = {
    GIT_AUTHOR_NAME: ADMISSION_GIT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: ADMISSION_GIT_IDENTITY.email,
    GIT_AUTHOR_DATE: ADMISSION_GIT_DATE,
    GIT_COMMITTER_NAME: ADMISSION_GIT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: ADMISSION_GIT_IDENTITY.email,
    GIT_COMMITTER_DATE: ADMISSION_GIT_DATE,
  };

  for (const source of input.sources) {
    if (source.kind === 'committed-patch') {
      for (let i = 1; i < source.commits.length; i++) {
        const order = run(['merge-base', '--is-ancestor', source.commits[i - 1]!, source.commits[i]!]);
        if (order.status === 1) {
          return {
            ok: false,
            code: 'invalid-patch-source',
            sourceIndex: source.index,
            detail: `source #${source.index}: patchCommits must follow integration ancestry (oldest first); nothing was built`,
          };
        }
        if (order.status !== 0) return failed('prove patch order', order, source.index);
      }
      const replayed: AppliedAdmissionSource & { kind: 'committed-patch' } = {
        index: source.index,
        kind: 'committed-patch',
        paths: source.paths,
        patches: [],
        headAfter: head,
      };
      for (const patchCommit of source.commits) {
        const built = buildCommittedPatchSource({
          root: input.root,
          repairHead: head,
          patchCommit,
          integrationRef: input.integrationRef,
          paths: source.paths,
          reason: input.reason,
          git,
        });
        if (!built.ok) {
          return {
            ok: false,
            code: built.code,
            sourceIndex: source.index,
            ...(built.path ? { path: built.path } : {}),
            detail: `source #${source.index} (patch ${patchCommit.slice(0, 12)}): ${built.detail}`,
          };
        }
        replayed.patches.push(built.patch);
        patches.push(built.patch);
        head = built.sourceCommit;
      }
      replayed.headAfter = head;
      applied.push(replayed);
      continue;
    }

    // whole-blob
    let sourceSha = tip.sha;
    if (source.sourceCommit !== undefined) {
      const pinned = resolve(source.sourceCommit);
      if (!pinned.ok) {
        return {
          ok: false,
          code: 'source-commit-unresolvable',
          sourceIndex: source.index,
          detail: `source #${source.index}: sourceCommit ${source.sourceCommit} does not resolve to a commit`,
        };
      }
      const ancestor = run(['merge-base', '--is-ancestor', pinned.sha, tip.sha]);
      if (ancestor.status === 1) {
        return {
          ok: false,
          code: 'source-commit-not-integrated',
          sourceIndex: source.index,
          detail: `source #${source.index}: sourceCommit ${pinned.sha} is not an ancestor of ${input.integrationRef}`,
        };
      }
      if (ancestor.status !== 0) return failed('prove sourceCommit ancestry', ancestor, source.index);
      sourceSha = pinned.sha;
    }
    const entries = new Map<string, { mode: string; type: string; oid: string }>();
    const atHead = new Set<string>();
    for (const [ref, sink] of [[sourceSha, 'source'], [head, 'head']] as const) {
      const ls = run(['ls-tree', '-z', ref, '--', ...source.paths]);
      if (ls.status !== 0) return failed(`read ${sink} entries`, ls, source.index);
      for (const line of ls.stdout.split('\0').filter(Boolean)) {
        const m = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(line);
        if (!m || !source.paths.includes(m[4]!)) {
          return failed(`parse ${sink} entries`, { status: 0, stdout: line, stderr: 'unexpected ls-tree entry' }, source.index);
        }
        if (sink === 'source') entries.set(m[4]!, { mode: m[1]!, type: m[2]!, oid: m[3]! });
        else atHead.add(m[4]!);
      }
    }
    for (const path of source.paths) {
      const entry = entries.get(path);
      if (entry && (entry.type !== 'blob' || !/^(100644|100755|120000)$/.test(entry.mode))) {
        return {
          ok: false,
          code: 'not-a-blob',
          sourceIndex: source.index,
          path,
          detail:
            `source #${source.index}: ${path} is a ${entry.type === 'commit' ? 'submodule gitlink' : entry.type} at the source — ` +
            'a multi-source admission carries regular files and symlinks only; admit a gitlink in its own call',
        };
      }
      if (!entry && !atHead.has(path)) {
        return {
          ok: false,
          code: 'invalid-paths',
          sourceIndex: source.index,
          path,
          detail:
            `source #${source.index}: ${path} exists neither at the source nor at repairHead (a path inside a submodule ` +
            'cannot ride a multi-source admission — admit it in its own call)',
        };
      }
    }
    const scratch = mkdtempSync(join(tmpdir(), 'papercusp-multi-source-'));
    const indexEnv = { GIT_INDEX_FILE: join(scratch, 'index') };
    try {
      const read = run(['read-tree', head], indexEnv);
      if (read.status !== 0) return failed('read-tree', read, source.index);
      for (const path of source.paths) {
        const entry = entries.get(path);
        const ui = entry
          ? run(['update-index', '--add', '--replace', '--cacheinfo', `${entry.mode},${entry.oid},${path}`], indexEnv)
          : run(['update-index', '--force-remove', '--', path], indexEnv);
        if (ui.status !== 0) return failed(`update-index ${path}`, ui, source.index);
      }
      const wt = run(['write-tree'], indexEnv);
      const tree = wt.stdout.trim();
      if (wt.status !== 0 || !FULL_SHA_RE.test(tree)) return failed('write-tree', wt, source.index);
      const ct = run(
        [
          'commit-tree', tree, '-p', head, '-m',
          `Whole-blob source #${source.index}\n\nsource: ${sourceSha}${source.sourceCommit ? ' (pinned)' : ` (${input.integrationRef} tip)`}\n` +
            `paths: ${JSON.stringify(source.paths)}\nreason: ${input.reason}\n\nBuilt by papercusp release:repair-queue admit (multi-source, P-002).\n`,
        ],
        identityEnv,
      );
      const commit = ct.stdout.trim();
      if (ct.status !== 0 || !FULL_SHA_RE.test(commit)) return failed('commit-tree', ct, source.index);
      head = commit;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    applied.push({
      index: source.index,
      kind: 'whole-blob',
      paths: source.paths,
      sourceCommit: sourceSha,
      pinned: source.sourceCommit !== undefined,
      headAfter: head,
    });
    const group = cohort.find((c) => c.sourceCommit === sourceSha);
    if (group) for (const p of source.paths) { if (!group.paths.includes(p)) group.paths.push(p); }
    else cohort.push({ sourceCommit: sourceSha, paths: [...source.paths] });
  }

  const treeOf = run(['rev-parse', '--verify', `${head}^{tree}`]);
  const tree = treeOf.stdout.trim();
  if (treeOf.status !== 0 || !FULL_SHA_RE.test(tree)) return failed('resolve combined tree', treeOf);
  const paths: string[] = [];
  for (const source of input.sources) for (const p of source.paths) if (!paths.includes(p)) paths.push(p);
  return { ok: true, sourceCommit: head, tree, paths, applied, patches, cohortSources: cohort, integrationTip: tip.sha };
}
