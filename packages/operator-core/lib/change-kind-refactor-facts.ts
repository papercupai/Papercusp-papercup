/**
 * The resolver behind the 'refactor' change-kind proof (plan code-cleanup-campaigns-2026-10-26,
 * P-004 / R-4). change-kind-refactor-proof.ts holds the rules; this module establishes the facts
 * those rules judge:
 *
 *   - the landing commit and its first parent (git, in the completion's repository root);
 *   - the cited test_runs rows (id, file, commit, status, dirty flag);
 *   - the files the landing change touched, and its new-side hunks (git diff parent..landing);
 *   - the test files that cover each touched hunk (the source-bound coverage map — computed here,
 *     never taken from the agent's filesChanged);
 *   - whether the registered detector still reports the filed finding over the current tree.
 *
 * Every fact the resolver cannot establish stays `null` (or lands in `errors`), and the rules
 * refuse on `null`, so a resolver fault can only fail closed.
 *
 * Scope limits, stated so a refusal is not misread:
 *   - the landing commit must be in the completion's repository (a submodule refactor is refused);
 *   - a touched file that changed again after the landing has no mappable coverage, so its hunks
 *     count as uncovered;
 *   - semantic (non-structural) clone families cannot be re-scanned here, so a finding that names
 *     one is reported as not re-scannable.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RefactorFacts, RefactorFactsResolver, RefactorRunRow } from './change-kind-refactor-proof';
import { CloneIndex, classifyClonePath } from './code-intelligence/clone-index';
import { cloneFamilyArea, rankCloneSweep } from './code-intelligence/clone-sweep';

export interface LineRange {
  start: number;
  end: number;
}

export type ParsedRefactorFinding =
  | { kind: 'area'; area: string }
  /** `fingerprint` is null for a semantic family, which a structural re-scan cannot see. */
  | { kind: 'family'; familyId: string; fingerprint: string | null }
  | { kind: 'guard-reachability'; conditionKey: string; path: string };

/** What the filed cleanup item says the finding covers. */
export interface FiledRefactorFinding {
  /** Every member path the filed families named. */
  memberPaths: readonly string[];
  /** Structural ('renamed') fingerprints of the filed families. */
  fingerprints: readonly string[];
  /** Filed family ids that are not structural (semantic) and so cannot be re-scanned. */
  semanticFamilyIds: readonly string[];
  /** Present only after validating the system-filed sync-batch guard record. */
  guard?: { conditionKey: string; path: string };
}

export interface TouchedCoverage {
  members: RefactorFacts['touchedMembers'];
  errors: readonly string[];
}

/** The I/O the resolver needs, injected so the orchestration is testable without git or a DB. */
export interface RefactorFactsIo {
  /** Runs git in the repository root; resolves stdout, rejects on a non-zero exit. */
  git(args: readonly string[]): Promise<string>;
  readRuns(ids: readonly number[]): Promise<RefactorRunRow[]>;
  /**
   * Covering test files for each touched source hunk. `staleSince` lists paths whose working-tree
   * content differs from the landing commit, so their landing line numbers cannot be mapped.
   */
  coverage(hunks: ReadonlyMap<string, readonly LineRange[]>, staleSince: ReadonlySet<string>): Promise<TouchedCoverage>;
  readFiled(finding: ParsedRefactorFinding): Promise<FiledRefactorFinding | null>;
  /** Current-tree source for a repo-relative path; null when the file does not exist. */
  readSource(path: string): Promise<string | null>;
  /** Fixed production detector census; callers cannot select commands or supply a verdict. */
  guardReachabilityCensus?(): Promise<unknown>;
}

const COVERABLE_SOURCE_RE = /\.(?:[cm]?[jt]sx?)$/;
const CLONE_SCANNABLE_RE = /\.tsx?$/;
const GENERATED_RE = /\.d\.ts$|\.gen\.tsx?$/;

/** A changed file whose hunks need covering tests: code, not a test, not generated. */
export function isCoverableSource(path: string): boolean {
  return COVERABLE_SOURCE_RE.test(path) && !GENERATED_RE.test(path) && !classifyClonePath(path).test;
}

/** A file the clone sweep indexes (scripts/clone-family-sweep.mts applies the same filter). */
export function isCloneScannable(path: string): boolean {
  const c = classifyClonePath(path);
  return CLONE_SCANNABLE_RE.test(path) && !GENERATED_RE.test(path) && !c.test && !c.retired;
}

/**
 * New-side line ranges per file from `git diff -U0 --no-renames` output. A pure-deletion hunk
 * (`+N,0`) maps to the single line it sits beside. Deleted files are omitted: they have no
 * new-side lines to cover.
 */
export function parseDiffHunks(diff: string): Map<string, LineRange[]> {
  const out = new Map<string, LineRange[]>();
  let current: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      current = target === '/dev/null' ? null : target.replace(/^b\//, '');
      if (current && !out.has(current)) out.set(current, []);
      continue;
    }
    if (!current) continue;
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    const first = Math.max(start, 1);
    out.get(current)!.push({ start: first, end: count === 0 ? first : start + count - 1 });
  }
  return out;
}

const GUARD_FINDING_PREFIX = 'sync-delta-guard:lint:guard-reachability:';

/** Accepts existing clone keys and the system sync-batch guard's exact path identity. */
export function parseRefactorFinding(finding: string): ParsedRefactorFinding | null {
  const f = finding.trim();
  if (f.startsWith('sync-delta-guard:')) {
    if (!f.startsWith(GUARD_FINDING_PREFIX)) return null;
    const path = f.slice(GUARD_FINDING_PREFIX.length);
    if (!/^(?:apps|packages|libs)\/[A-Za-z0-9_./-]+\.tsx?$/.test(path) || path.split('/').some((p) => !p || p === '.' || p === '..')) return null;
    return { kind: 'guard-reachability', conditionKey: f, path };
  }
  if (f.startsWith('clone-area:')) {
    const area = f.slice('clone-area:'.length).trim();
    return area ? { kind: 'area', area } : null;
  }
  const id = (f.startsWith('clone-family:') ? f.slice('clone-family:'.length) : f).trim();
  const at = id.lastIndexOf(':renamed:');
  if (at >= 0) {
    const fingerprint = id.slice(at + ':renamed:'.length);
    return fingerprint ? { kind: 'family', familyId: id, fingerprint } : null;
  }
  if (id.includes(':semantic:')) return { kind: 'family', familyId: id, fingerprint: null };
  return null;
}

/**
 * Reads a filed cleanup item's `payload.cloneArea` (clone-sweep.ts fileCloneSweep) into the
 * members and fingerprints a re-scan needs. For a family finding only that family counts.
 */
export function filedFindingFromPayload(cloneArea: unknown, finding: ParsedRefactorFinding): FiledRefactorFinding | null {
  if (finding.kind === 'guard-reachability') return null;
  const families = (cloneArea as { families?: unknown } | null)?.families;
  if (!Array.isArray(families)) return null;
  const memberPaths = new Set<string>();
  const fingerprints = new Set<string>();
  const semanticFamilyIds: string[] = [];
  let matched = 0;
  for (const raw of families as Array<{ id?: unknown; members?: unknown }>) {
    const id = typeof raw?.id === 'string' ? raw.id : null;
    if (!id) continue;
    if (finding.kind === 'family' && id !== finding.familyId) continue;
    matched++;
    const parsed = parseRefactorFinding(id);
    if (parsed?.kind === 'family' && parsed.fingerprint) fingerprints.add(parsed.fingerprint);
    else semanticFamilyIds.push(id);
    for (const m of Array.isArray(raw.members) ? (raw.members as Array<{ path?: unknown }>) : []) {
      if (typeof m?.path === 'string' && m.path) memberPaths.add(m.path);
    }
  }
  if (!matched) return null;
  return { memberPaths: [...memberPaths].sort(), fingerprints: [...fingerprints].sort(), semanticFamilyIds };
}

/** Reuse the real sync-batch writer's payload, never a caller-authored detector result. */
export function filedGuardFindingFromPayload(payload: unknown, finding: ParsedRefactorFinding): FiledRefactorFinding | null {
  if (finding.kind !== 'guard-reachability' || !payload || typeof payload !== 'object') return null;
  const p = payload as { filedBy?: unknown; paths?: unknown; _conditionUpsert?: { conditionKey?: unknown } };
  if (p.filedBy !== 'system:sync-batch-lint-guards' || p._conditionUpsert?.conditionKey !== finding.conditionKey ||
      !Array.isArray(p.paths) || !p.paths.includes(finding.path)) return null;
  return { memberPaths: [finding.path], fingerprints: [], semanticFamilyIds: [], guard: { conditionKey: finding.conditionKey, path: finding.path } };
}

/** A missing/incomplete population is an instrument fault, never proof of absence. */
export function guardFindingReportedInCensus(census: unknown, path: string, source: string | null): boolean {
  const modules = (census as { modules?: { measurable?: unknown; population?: unknown; inventory?: unknown } } | null)?.modules;
  if (modules?.measurable !== true || !Array.isArray(modules.inventory) ||
      !Number.isInteger(modules.population) || modules.population !== modules.inventory.length || modules.inventory.length === 0) {
    throw new Error('guard-reachability module census is unmeasured or incomplete');
  }
  const inventory = modules.inventory as Array<{ module?: unknown; dead?: unknown }>;
  if (inventory.some((r) => !r || typeof r.module !== 'string' || typeof r.dead !== 'boolean') ||
      new Set(inventory.map((r) => r.module)).size !== inventory.length) {
    throw new Error('guard-reachability module inventory is malformed');
  }
  const row = inventory.find((r) => r.module === path);
  if (source === null) {
    if (row) throw new Error('deleted guard subject remains in the census; source changed during the scan');
    return false;
  }
  if (!row) throw new Error('readable guard subject is missing from the detector population');
  return row.dead as boolean;
}

/** Closed adapter dispatch: only registered detectors can produce the shared finding fact. */
async function rescanFiledFinding(io: RefactorFactsIo, finding: ParsedRefactorFinding, filed: FiledRefactorFinding, changedFiles: readonly string[]): Promise<boolean> {
  const adapters = {
    'guard-reachability': async () => {
      if (finding.kind !== 'guard-reachability' || filed.guard?.conditionKey !== finding.conditionKey ||
          filed.guard.path !== finding.path || !io.guardReachabilityCensus) throw new Error('registered guard finding or detector is unavailable');
      const source = await io.readSource(finding.path);
      const census = await io.guardReachabilityCensus();
      if (await io.readSource(finding.path) !== source) throw new Error('guard subject changed during the detector scan');
      return guardFindingReportedInCensus(census, finding.path, source);
    },
    clone: async () => {
      const paths = [...new Set([...filed.memberPaths, ...changedFiles])].filter(isCloneScannable).sort();
      const index = new CloneIndex();
      const unreadable: string[] = [];
      for (const path of paths) {
        const source = await io.readSource(path);
        if (source === null) continue;
        const status = index.update({ path, source }).file.status;
        if (status === 'syntax-error' || status === 'unavailable') unreadable.push(path);
      }
      if (unreadable.length) throw new Error(`could not parse ${unreadable.join(', ')}`);
      return findingReportedIn(index, finding, filed.fingerprints);
    },
  };
  return adapters[finding.kind === 'guard-reachability' ? 'guard-reachability' : 'clone']();
}

/**
 * Whether the detector still reports the finding in `index`: a family the sweep would rank shares
 * a filed fingerprint, or (for an area) still lands in the filed area.
 */
export function findingReportedIn(index: CloneIndex, finding: ParsedRefactorFinding, fingerprints: readonly string[]): boolean {
  const filed = new Set(fingerprints);
  return rankCloneSweep(index, { acceptances: [], genericEvidence: [] }).some(
    (row) =>
      filed.has(row.family.fingerprint) ||
      (finding.kind === 'area' && cloneFamilyArea(row.family.members) === finding.area),
  );
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const lines = (text: string) =>
  text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

/** Builds the resolver over injected I/O. Never throws: every failure becomes a null fact or an error. */
export function createRefactorFactsResolver(io: RefactorFactsIo): RefactorFactsResolver {
  return async (query) => {
    const errors: string[] = [];
    async function attempt<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
      try {
        return await fn();
      } catch (e) {
        errors.push(`${label}: ${message(e)}`);
        return fallback;
      }
    }
    // A sha that does not resolve is a finding for the rules, not a resolver error.
    const revParse = async (rev: string) => {
      try {
        return (await io.git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])).trim() || null;
      } catch {
        return null;
      }
    };

    const landing = await revParse(query.landingCommit);
    const parent = landing ? await revParse(`${landing}^1`) : null;
    const [beforeRuns, afterRuns] = await Promise.all([
      attempt('reading the before-run rows', () => io.readRuns(query.beforeRunIds), [] as RefactorRunRow[]),
      attempt('reading the after-run rows', () => io.readRuns(query.afterRunIds), [] as RefactorRunRow[]),
    ]);

    let changedFiles: string[] | null = null;
    let touchedMembers: RefactorFacts['touchedMembers'] = null;
    let findingStillReported: boolean | null = null;

    if (landing && parent) {
      changedFiles = await attempt(
        'listing the landing change files',
        async () => lines(await io.git(['-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', parent, landing])),
        null,
      );
      const hunks = await attempt(
        'reading the landing change hunks',
        async () =>
          parseDiffHunks(await io.git(['-c', 'core.quotePath=false', 'diff', '-U0', '--no-renames', '--no-color', parent, landing])),
        null,
      );
      if (hunks) {
        const source = new Map([...hunks].filter(([path, ranges]) => isCoverableSource(path) && ranges.length > 0));
        if (source.size === 0) {
          touchedMembers = [];
        } else {
          const staleSince = await attempt(
            'comparing the touched files with the current tree',
            async () =>
              new Set(lines(await io.git(['-c', 'core.quotePath=false', 'diff', '--name-only', landing, '--', ...source.keys()]))),
            null,
          );
          if (staleSince) {
            const coverage = await attempt('reading the coverage map', () => io.coverage(source, staleSince), {
              members: null,
              errors: [],
            } as TouchedCoverage);
            errors.push(...coverage.errors);
            touchedMembers = coverage.members;
          }
        }
      }

      const parsed = parseRefactorFinding(query.finding);
      if (!parsed) {
        errors.push(`the finding '${query.finding}' is not a registered clone or guard-reachability key`);
      } else {
        const filed = await attempt('reading the filed finding', () => io.readFiled(parsed), null);
        if (!filed) {
          errors.push(`no filed cleanup item names the finding '${query.finding}', so its members are unknown`);
        } else if (filed.semanticFamilyIds.length > 0 || (parsed.kind === 'family' && !parsed.fingerprint)) {
          errors.push(
            `the finding names semantic clone famil${filed.semanticFamilyIds.length === 1 ? 'y' : 'ies'} ` +
              `(${filed.semanticFamilyIds.join(', ') || query.finding}), which a structural re-scan cannot see`,
          );
        } else {
          findingStillReported = await attempt(
            're-scanning for the finding',
            () => rescanFiledFinding(io, parsed, filed, changedFiles ?? []),
            null,
          );
        }
      }
    }

    return { landingCommit: landing, landingParent: parent, beforeRuns, afterRuns, changedFiles, touchedMembers, findingStillReported, errors };
  };
}

// Promisified lazily on first call, never at module scope (EI-10161): an eager
// promisify(execFile) throws at import time under a narrow node:child_process test mock.
let cachedExecFileAsync: typeof execFile.__promisify__ | undefined;
const execFileAsync = ((...args: Parameters<typeof execFile.__promisify__>) =>
  (cachedExecFileAsync ??= promisify(execFile))(...args)) as typeof execFile.__promisify__;

/** Production I/O: git in `root`, test_runs + work_items in Postgres, the native coverage map. */
export function nativeRefactorFactsResolver(scope: { root: string; workspaceId: string; harness: string }): RefactorFactsResolver {
  const { root, workspaceId, harness } = scope;
  const sql = async () => (await import('@papercusp/db-org')).getOrgPg().sql;
  return createRefactorFactsResolver({
    async git(args) {
      const { stdout } = await execFileAsync('git', ['-C', root, ...args], { maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
      return stdout;
    },
    async readRuns(ids) {
      if (!ids.length) return [];
      const db = await sql();
      // CI rows carry a NULL workspace by design, so only another workspace's rows are excluded.
      const rows = await db<{ id: string; file_path: string; commit_sha: string | null; status: string; worktree_dirty: boolean | null }[]>`
        SELECT id, file_path, commit_sha, status, worktree_dirty
          FROM harness_shared.test_runs
         WHERE id = ANY(${ids.map(String)}::bigint[])
           AND (workspace_id = ${workspaceId} OR workspace_id IS NULL)`;
      return rows.map((r) => ({
        id: Number(r.id),
        filePath: r.file_path,
        commitSha: r.commit_sha,
        status: r.status,
        worktreeDirty: r.worktree_dirty,
      }));
    },
    async readFiled(finding) {
      const db = await sql();
      if (finding.kind === 'guard-reachability') {
        const rows = await db<{ payload: unknown }[]>`
          SELECT payload FROM harness_shared.work_items
           WHERE workspace_id = ${workspaceId} AND harness_slug = ${harness}
             AND condition_key = ${finding.conditionKey}
           ORDER BY updated_at DESC LIMIT 1`;
        return rows[0] ? filedGuardFindingFromPayload(rows[0].payload, finding) : null;
      }
      const rows =
        finding.kind === 'area'
          ? await db<{ clone_area: unknown }[]>`
              SELECT payload->'cloneArea' AS clone_area FROM harness_shared.work_items
               WHERE workspace_id = ${workspaceId} AND harness_slug = ${harness}
                 AND condition_key = ${`clone-area:${finding.area}`}
               ORDER BY updated_at DESC LIMIT 1`
          : await db<{ clone_area: unknown }[]>`
              SELECT payload->'cloneArea' AS clone_area FROM harness_shared.work_items
               WHERE workspace_id = ${workspaceId} AND harness_slug = ${harness}
                 AND payload->'cloneArea'->'families' @> ${JSON.stringify([{ id: finding.familyId }])}::jsonb
               ORDER BY updated_at DESC LIMIT 1`;
      return rows[0] ? filedFindingFromPayload(rows[0].clone_area, finding) : null;
    },
    async guardReachabilityCensus() {
      const env = { ...process.env };
      delete env.LINT_GUARD_REACHABILITY_PACKAGE_JSON;
      delete env.LINT_GUARD_REACHABILITY_AFFECTED_TESTS;
      const { stdout } = await execFileAsync(process.execPath, [join(root, 'scripts/check-lint-guard-reachability.mjs'), '--json', '--census'], {
        cwd: root, env, timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
      });
      return JSON.parse(stdout);
    },
    async readSource(path) {
      try {
        return await readFile(join(root, path), 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
        throw e;
      }
    },
    async coverage(hunks, staleSince) {
      const [{ coverageHash }, { readNativeCoverageScope, queryTestCoverage }] = await Promise.all([
        import('@papercusp/test-config/test-coverage-map'),
        import('./code-intelligence/test-coverage-map'),
      ]);
      const mappable = [...hunks.keys()].filter((p) => !staleSince.has(p));
      const members: Array<{ member: string; coveringFiles: string[] }> = [];
      for (const path of hunks.keys()) {
        if (!staleSince.has(path)) continue;
        for (const r of hunks.get(path)!) {
          members.push({ member: `${path}:${r.start}-${r.end} (changed again after the landing commit; coverage cannot be mapped)`, coveringFiles: [] });
        }
      }
      if (!mappable.length) return { members, errors: [] };
      const sourceFiles = await Promise.all(
        mappable.map(async (path) => ({ path, sha256: coverageHash(await readFile(join(root, path))) })),
      );
      const scopeData = await readNativeCoverageScope(
        {
          surface: 'completion',
          workspaceId,
          owner: 'system:change-kind-refactor-proof',
          invocation: 'work_items:complete',
          paths: mappable,
          sourceVersion: coverageHash(JSON.stringify(sourceFiles.map((s) => [s.path, s.sha256]))),
          repository: { workspaceId, rootPath: root, harness },
          sourceFiles,
        },
        AbortSignal.timeout(30_000),
      );
      if (!scopeData) return { members: null, errors: ['the coverage map has no source-bound scope for the touched files'] };
      for (const path of mappable) {
        for (const r of hunks.get(path)!) {
          const answer = queryTestCoverage({
            root,
            question: { path, line1: r.start, endLine1: r.end },
            snapshots: scopeData.snapshots,
            currentHashes: scopeData.currentHashes,
            currentPopulation: scopeData.population,
          });
          members.push(
            answer.basis === 'execution'
              ? { member: `${path}:${r.start}-${r.end}`, coveringFiles: answer.tests }
              : { member: `${path}:${r.start}-${r.end} (${answer.reason})`, coveringFiles: [] },
          );
        }
      }
      return { members, errors: [] };
    },
  });
}
