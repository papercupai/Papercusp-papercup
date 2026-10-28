/**
 * P-010 / R-9 (change-provenance-and-admission-throughput-2026-10-27, D-006): the change trail
 * for ONE file — which commits changed it, who made each one, for which work-item, why that
 * work-item existed, and which recorded test runs judged those commits.
 *
 * File-centric on purpose (D-006): both uses D-003 kept start from a FILE — attributing a gate
 * red to the change that caused it (the eject rung), and "why does this line exist". The join is
 * "trailers plus test runs, nothing more" (D-003):
 *   1. `git log -- <path>` inside the repo that OWNS the path (a submodule for libs/papercusp/…);
 *   2. per commit, the Papercusp-Agent / Work-Item / Session / Plan trailers git-sync writes,
 *      read with {@link COMMIT_MESSAGE_FORMAT} + {@link parsePapercuspTrailers} (reused, never
 *      re-parsed here);
 *   3. per work-item: title, state, and its ORIGIN per D-001 — directive, else plan item, else
 *      link, else none;
 *   4. test_runs rows of the path and its sibling test file, each attached to the file version
 *      it tested (the last commit that changed the path as of the run's recorded sha). A run
 *      records a SUPERPROJECT sha, so for a submodule path it is followed down the gitlink
 *      chain to the submodule commit it pinned first (D-007, WI-6554700010030797).
 * A commit with no trailer reports `attributionSource: 'none'` rather than a guessed match.
 *
 * The core is pure over injected deps so it is testable against a real fixture repo with no PG.
 */
import fs from 'node:fs';
import nodePath from 'node:path';
import { execFile } from 'node:child_process';
import { parsePapercuspTrailers } from './edit-attribution';
import { COMMIT_MESSAGE_DELIMITER, COMMIT_MESSAGE_FORMAT } from './harness/git-sync/git-sync-attribution';

/** Record + field separators for the trail log. Built without a source escape (`lint:no-control-bytes`). */
const RECORD_SEP = String.fromCharCode(0x1d);
const FIELD_SEP = String.fromCharCode(0x1f);
/** `%x1d` starts each commit; header fields are `%x1f`-separated; the message sits between `%x1e`s. */
export const TRAIL_LOG_FORMAT = `%x1d%H%x1f%cI%x1f%s${COMMIT_MESSAGE_FORMAT}`;

export const CHANGE_TRAIL_MAX_LIMIT = 50;
export const CHANGE_TRAIL_DEFAULT_LIMIT = 20;

export interface TrailLogCommit {
  sha: string;
  committedAt: string;
  subject: string;
  message: string;
}

/** Parse `git log --format=TRAIL_LOG_FORMAT` output. Pure. */
export function parseTrailLog(stdout: string): TrailLogCommit[] {
  const out: TrailLogCommit[] = [];
  for (const block of (stdout ?? '').split(RECORD_SEP)) {
    if (!block.trim()) continue;
    const open = block.indexOf(COMMIT_MESSAGE_DELIMITER);
    const header = open >= 0 ? block.slice(0, open) : block;
    const close = open >= 0 ? block.indexOf(COMMIT_MESSAGE_DELIMITER, open + 1) : -1;
    const message = open >= 0 ? block.slice(open + 1, close >= 0 ? close : undefined) : '';
    const [sha = '', committedAt = '', subject = ''] = header.split(FIELD_SEP);
    if (!/^[0-9a-f]{40,64}$/.test(sha.trim())) continue;
    out.push({ sha: sha.trim(), committedAt: committedAt.trim(), subject: subject.trim(), message });
  }
  return out;
}

/** Parse the first header line of `git blame --porcelain`. An all-zero sha means "not committed yet". */
export function parseBlamePorcelain(stdout: string): { sha: string; uncommitted: boolean } | null {
  const first = (stdout ?? '').split('\n', 1)[0] ?? '';
  const m = /^([0-9a-f]{40,64}) \d+ \d+/.exec(first);
  if (!m) return null;
  return { sha: m[1], uncommitted: /^0+$/.test(m[1]) };
}

export interface WorkItemOriginRow {
  id: string;
  title?: string | null;
  state?: string | null;
  directiveRef?: string | number | null;
  sourcePlanSlug?: string | null;
  sourcePlanItemIds?: string[] | null;
  /** Non-`tagged` coord_links rows from this work-item, oldest first. */
  links?: Array<{ rel: string; dstKind: string; dstRef: string }>;
}

export type TrailOrigin =
  | { kind: 'directive'; ref: string }
  | { kind: 'plan-item'; ref: string }
  | { kind: 'link'; ref: string; rel: string }
  | { kind: 'none' };

/**
 * D-016 (supersedes D-001's order): plan item, else directive, else link, else "no recorded
 * origin". Work items come from plans; directive_ref is only a fallback (blind review G-9). Pure.
 */
export function workItemOrigin(row: WorkItemOriginRow): TrailOrigin {
  if (row.sourcePlanSlug) {
    const items = (row.sourcePlanItemIds ?? []).filter(Boolean);
    const ref = items.length ? items.map((i) => `${row.sourcePlanSlug}#${i}`).join(', ') : row.sourcePlanSlug;
    return { kind: 'plan-item', ref };
  }
  if (row.directiveRef !== null && row.directiveRef !== undefined && String(row.directiveRef) !== '') {
    return { kind: 'directive', ref: `#${row.directiveRef}` };
  }
  const link = (row.links ?? [])[0];
  if (link) return { kind: 'link', rel: link.rel, ref: `${link.dstKind}:${link.dstRef}` };
  return { kind: 'none' };
}

export interface TrailTestRun {
  file: string;
  status: string;
  commitSha: string;
  dirty: boolean | null;
  source: string | null;
  finishedAt: string | null;
}

export interface ChangeTrailDeps {
  git(args: string[], cwd: string): Promise<string>;
  readWorkItems(ids: string[]): Promise<WorkItemOriginRow[]>;
  /** Recorded runs of `paths` that finished at or after `sinceIso`, newest first. */
  readTestRuns(paths: string[], sinceIso: string): Promise<TrailTestRun[]>;
  exists?(absPath: string): boolean;
}

/** Most distinct run shas resolved to a file version per trail (one `git log -1` each). */
export const CHANGE_TRAIL_MAX_RUN_SHAS = 60;

export interface ChangeTrailInput {
  repoRoot: string;
  path: string;
  line?: number;
  since?: string;
  until?: string;
  limit?: number;
}

export interface ChangeTrailCommit {
  sha: string;
  committedAt: string;
  subject: string;
  attributionSource: 'trailer' | 'none';
  agent?: string;
  agents?: string[];
  sessionId?: string;
  planSlug?: string;
  workItems: Array<{ id: string; found: boolean; title?: string; state?: string; origin: TrailOrigin }>;
  testRuns: TrailTestRun[];
}

export interface ChangeTrail {
  path: string;
  /** 'superproject', or the owning submodule's path relative to repoRoot. */
  repo: string;
  relPath: string;
  line?: number;
  blame?: { sha: string; uncommitted: boolean };
  testFiles: string[];
  commits: ChangeTrailCommit[];
  /** True when `limit` commits came back, so older commits may exist. */
  truncated: boolean;
  notes: string[];
}

/** Resolve the repo that owns `path` (nearest ancestor holding `.git`, bounded at repoRoot). */
export function resolveOwningRepo(
  repoRoot: string,
  path: string,
  exists: (p: string) => boolean = fs.existsSync,
): { repoDir: string; repo: string; relPath: string; superRelPath: string } {
  const root = nodePath.resolve(repoRoot);
  const abs = nodePath.resolve(root, path);
  if (abs !== root && !abs.startsWith(root + nodePath.sep)) throw new Error(`path_outside_repo: ${path}`);
  const superRelPath = nodePath.relative(root, abs).split(nodePath.sep).join('/');
  let dir = nodePath.dirname(abs);
  while (dir.startsWith(root + nodePath.sep) && !exists(nodePath.join(dir, '.git'))) dir = nodePath.dirname(dir);
  if (!dir.startsWith(root + nodePath.sep)) dir = root;
  const relPath = nodePath.relative(dir, abs).split(nodePath.sep).join('/');
  const repo = dir === root ? 'superproject' : nodePath.relative(root, dir).split(nodePath.sep).join('/');
  return { repoDir: dir, repo, relPath, superRelPath };
}

/**
 * The gitlink hops from `repoRoot` down to `repoDir`, outermost first: each names the repo that
 * pins the next one and the submodule's path inside it. Empty for the superproject itself.
 */
export function submoduleChain(
  repoRoot: string,
  repoDir: string,
  exists: (p: string) => boolean = fs.existsSync,
): Array<{ parentDir: string; pathInParent: string }> {
  const root = nodePath.resolve(repoRoot);
  const repos: string[] = [];
  for (let d = nodePath.resolve(repoDir); d.startsWith(root + nodePath.sep); d = nodePath.dirname(d)) {
    if (exists(nodePath.join(d, '.git'))) repos.unshift(d);
  }
  let parentDir = root;
  return repos.map((dir) => {
    const hop = { parentDir, pathInParent: nodePath.relative(parentDir, dir).split(nodePath.sep).join('/') };
    parentDir = dir;
    return hop;
  });
}

/** The sibling test file a source file is judged by (`x.ts` → `x.test.ts`), when it exists. */
export function siblingTestFile(superRelPath: string, exists: (rel: string) => boolean): string | null {
  if (/\.test\.[cm]?[tj]sx?$/.test(superRelPath)) return null;
  const m = /^(.*)\.([cm]?[tj]sx?)$/.exec(superRelPath);
  if (!m) return null;
  const candidate = `${m[1]}.test.${m[2]}`;
  return exists(candidate) ? candidate : null;
}

export async function buildChangeTrail(input: ChangeTrailInput, deps: ChangeTrailDeps): Promise<ChangeTrail> {
  const exists = deps.exists ?? fs.existsSync;
  const limit = Math.max(1, Math.min(CHANGE_TRAIL_MAX_LIMIT, Math.floor(input.limit ?? CHANGE_TRAIL_DEFAULT_LIMIT)));
  const owner = resolveOwningRepo(input.repoRoot, input.path, exists);
  const notes: string[] = [];
  const sibling = siblingTestFile(owner.superRelPath, (rel) => exists(nodePath.resolve(input.repoRoot, rel)));
  const testFiles = [owner.superRelPath, ...(sibling ? [sibling] : [])];

  let raw: TrailLogCommit[];
  let blame: ChangeTrail['blame'];
  if (input.line !== undefined) {
    const n = Math.max(1, Math.floor(input.line));
    const blameOut = await deps.git(['blame', '--porcelain', '-L', `${n},${n}`, '--', owner.relPath], owner.repoDir);
    const parsed = parseBlamePorcelain(blameOut);
    if (!parsed) throw new Error(`blame_unparseable: line ${n} of ${owner.superRelPath}`);
    blame = parsed;
    if (parsed.uncommitted) {
      raw = [];
      notes.push(`line ${n} is not committed yet, so no commit, agent or work-item owns it`);
    } else {
      raw = parseTrailLog(await deps.git(['log', '-1', `--format=${TRAIL_LOG_FORMAT}`, parsed.sha], owner.repoDir));
    }
  } else {
    const args = ['log', '-n', String(limit), `--format=${TRAIL_LOG_FORMAT}`];
    if (input.since) args.push(`--since=${input.since}`);
    if (input.until) args.push(`--until=${input.until}`);
    raw = parseTrailLog(await deps.git([...args, '--', owner.relPath], owner.repoDir));
  }

  const parsed = raw.map((c) => ({ c, t: parsePapercuspTrailers(c.message) }));
  const ids = [...new Set(parsed.flatMap((p) => p.t.workItems))];
  const rows = ids.length ? await deps.readWorkItems(ids) : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  // A run records the superproject HEAD it ran at, which is almost never the commit that changed
  // the file (measured 2026-10-28: 50 runs of edit-attribution.{ts,test.ts} over 28 shas, none at a
  // changing commit). So each run is attached to the file VERSION it tested: the last commit that
  // changed the path as of the run's sha (`git log -1 <runSha> -- <path>`). A run sha is a
  // SUPERPROJECT sha, so for a submodule path it is first followed down the gitlink chain
  // (`git rev-parse <sha>:<submodule>` per level) to the submodule commit it pinned.
  const runsByCommit = new Map<string, TrailTestRun[]>();
  if (raw.length) {
    const oldest = raw[raw.length - 1].committedAt;
    const runs = await deps.readTestRuns(testFiles, oldest);
    const runShas = [...new Set(runs.map((r) => r.commitSha))];
    const resolvable = runShas.slice(0, CHANGE_TRAIL_MAX_RUN_SHAS);
    const hops = submoduleChain(input.repoRoot, owner.repoDir, exists);
    const versionOf = new Map<string, string>();
    const versionAtPin = new Map<string, string>();
    let unresolved = 0;
    for (const runSha of resolvable) {
      try {
        let pin = runSha;
        for (const hop of hops) {
          pin = (await deps.git(['rev-parse', `${pin}:${hop.pathInParent}`], hop.parentDir)).trim();
          if (!pin) throw new Error('no_gitlink');
        }
        let v = versionAtPin.get(pin);
        if (v === undefined) {
          v = (await deps.git(['log', '-1', '--format=%H', pin, '--', owner.relPath], owner.repoDir)).trim();
          versionAtPin.set(pin, v);
        }
        if (v) versionOf.set(runSha, v);
      } catch {
        unresolved += 1;
      }
    }
    for (const r of runs) {
      const v = versionOf.get(r.commitSha);
      if (!v) continue;
      runsByCommit.set(v, [...(runsByCommit.get(v) ?? []), r]);
    }
    if (unresolved) {
      notes.push(
        `${unresolved} run sha(s) could not be resolved to a version of ${owner.superRelPath} (sha not in this checkout${hops.length ? `, or ${owner.repo} not pinned at it` : ''}), so their runs are not attributed`,
      );
    }
    if (runShas.length > resolvable.length) {
      notes.push(`runs at ${runShas.length - resolvable.length} older sha(s) were not attributed (cap ${CHANGE_TRAIL_MAX_RUN_SHAS})`);
    }
  }

  const commits: ChangeTrailCommit[] = parsed.map(({ c, t }) => {
    const attributed = Boolean(t.agent) || t.workItems.length > 0;
    return {
      sha: c.sha,
      committedAt: c.committedAt,
      subject: c.subject,
      attributionSource: attributed ? 'trailer' : 'none',
      ...(t.agent ? { agent: t.agent } : {}),
      ...(t.agents ? { agents: t.agents } : {}),
      ...(t.sessionId ? { sessionId: t.sessionId } : {}),
      ...(t.planSlug ? { planSlug: t.planSlug } : {}),
      workItems: t.workItems.map((id) => {
        const row = byId.get(id);
        if (!row) return { id, found: false, origin: { kind: 'none' } as TrailOrigin };
        return {
          id,
          found: true,
          ...(row.title ? { title: row.title } : {}),
          ...(row.state ? { state: row.state } : {}),
          origin: workItemOrigin(row),
        };
      }),
      testRuns: runsByCommit.get(c.sha) ?? [],
    };
  });

  return {
    path: owner.superRelPath,
    repo: owner.repo,
    relPath: owner.relPath,
    ...(input.line !== undefined ? { line: Math.max(1, Math.floor(input.line)) } : {}),
    ...(blame ? { blame } : {}),
    testFiles,
    commits,
    truncated: input.line === undefined && raw.length >= limit,
    notes,
  };
}

/** Production deps: git via execFile, work-items + coord_links + test_runs via the org pool. */
export function defaultChangeTrailDeps(workspaceId: string): ChangeTrailDeps {
  return {
    git: (args, cwd) =>
      new Promise((resolve, reject) => {
        execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 15_000 }, (err, stdout) =>
          err ? reject(err) : resolve(String(stdout)),
        );
      }),
    async readWorkItems(ids) {
      const { getOrgPg } = await import('@papercusp/db-org');
      const { sql } = getOrgPg();
      const items = (await sql`
        SELECT feature_id, title, status, directive_ref, source_plan_slug, source_plan_item_ids
          FROM harness_shared.work_items
         WHERE workspace_id = ${workspaceId} AND feature_id = ANY(${ids}::text[])`) as unknown as Array<Record<string, any>>;
      const links = (await sql`
        SELECT src_ref, rel, dst_kind, dst_ref
          FROM harness_shared.coord_links
         WHERE workspace_id = ${workspaceId} AND src_ref = ANY(${ids}::text[]) AND rel <> 'tagged'
         ORDER BY id`) as unknown as Array<Record<string, any>>;
      return items.map((r) => ({
        id: String(r.feature_id),
        title: r.title ?? null,
        state: r.status ?? null,
        directiveRef: r.directive_ref ?? null,
        sourcePlanSlug: r.source_plan_slug ?? null,
        sourcePlanItemIds: r.source_plan_item_ids ?? null,
        links: links
          .filter((l) => l.src_ref === r.feature_id)
          .map((l) => ({ rel: String(l.rel), dstKind: String(l.dst_kind), dstRef: String(l.dst_ref) })),
      }));
    },
    async readTestRuns(paths, sinceIso) {
      const { getOrgPg } = await import('@papercusp/db-org');
      const { sql } = getOrgPg();
      // Never scoped by workspace_id: CI rows carry workspace_id NULL by design.
      const rows = (await sql`
        SELECT file_path, status, commit_sha, worktree_dirty, source, finished_at
          FROM harness_shared.test_runs
         WHERE file_path = ANY(${paths}::text[]) AND finished_at >= ${sinceIso}::timestamptz
           AND commit_sha IS NOT NULL AND source <> 'mutation-probe'
         ORDER BY finished_at DESC
         LIMIT 200`) as unknown as Array<Record<string, any>>;
      return rows.map((r) => ({
        file: String(r.file_path),
        status: String(r.status),
        commitSha: String(r.commit_sha),
        dirty: r.worktree_dirty ?? null,
        source: r.source ?? null,
        finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
      }));
    },
  };
}
