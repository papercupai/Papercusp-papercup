/**
 * WI-10005223: the frozen-repair ADMISSION git work, as serializable jobs.
 *
 * The admission builders (repair-head-admission, hunk-exact-admission, the two preflights,
 * judged-sha-containment) are synchronous on purpose: every step is a `spawnSync('git')`,
 * and a sync sequence cannot interleave with a second admission. Run on the operator's MAIN
 * thread, that same property blocked the event loop for the whole sequence — measured avg
 * 4.3-12.4s per admit, max 61.8s, past the sentinel's 20s wedge-kill threshold.
 *
 * This module does not change a single builder. It names each call the admit door makes as
 * a plain-data job and dispatches it to the UNCHANGED sync function, so the same code runs
 * either on a worker thread (admission-offthread.ts, the production path) or inline. Every
 * job input and result is structured-cloneable: the only non-data inputs the builders take —
 * the `git` runner and the `preflight` closure — are never sent. The worker always uses the
 * real git runner, and the preflight is rebuilt here from its plain spec.
 */
import {
  admitPathsOntoRepairHead,
  realAdmissionGit,
  retractAdmission,
  type AdmissionGitResult,
  type AdmissionOutcome,
  type AdmitPathsInput,
} from './repair-head-admission';
import { reconcileFrozenRepairQueueWithLineageRef } from './frozen-lineage-ledger-reconcile';
import type { FrozenCandidateRepairQueue } from './frozen-candidate-repair-queue';
import {
  buildCommittedPatchSource,
  buildHunkExactSource,
  type BuildHunkExactSourceInput,
  type HunkExactSourceOutcome,
} from './hunk-exact-admission';
import { containmentForPaths } from './judged-sha-containment';
import { importCompletenessPreflight, readAdmissionBlobBatch } from './admission-import-completeness';
import { dirname, resolve, relative, sep } from 'node:path';
import {
  precheckPopulation,
  resolveCanonicalIntegrationRoot,
  isTestFilePath,
  type AdmissionRadius,
  type SignatureLike,
  type FixPrecheckPopulation,
} from './admission-fix-precheck';
import {
  buildIndex,
  edgeCacheKey,
  isTestFile,
  playwrightOwnedTest,
  selectRelatedTests,
  tsconfigPathEntriesFor,
  type ParsedEdges,
} from '../../../../scripts/lib/related-tests.mjs';
import { pinModuleState } from '@papercusp/module-singleton';
import {
  chainAdmissionPreflights,
  lockfileManifestConsistencyPreflight,
} from './admission-lockfile-consistency';

/**
 * The admit door's preflight, as data. The door always chains the import-completeness check
 * and the lockfile/manifest consistency check against the same probe ref; only the ref and
 * the whole-blob cohort flag vary.
 */
export interface AdmissionPreflightSpec {
  probeRef: string;
  /** D-045: whole-blob admissions also close the same-source cohort. Omitted = forward check only. */
  enforceSourceCohort?: true;
}

type CommittedPatchInput = Omit<Parameters<typeof buildCommittedPatchSource>[0], 'git'>;
type RetractInput = Omit<Parameters<typeof retractAdmission>[0], 'git'>;

export interface ImmutablePrecheckInput {
  root: string;
  commit: string;
  signature: readonly SignatureLike[];
  admittedPaths: readonly string[];
}

type Entry = { mode: string; type: string; sha: string; file: string };

/** Every entry of `commit`'s tree in the repository at `cwd` — the pinned commit, never the working tree. */
function treeAt(cwd: string, commit: string): Entry[] {
  const tree = realAdmissionGit(['ls-tree', '-r', '-z', '--full-tree', commit], { cwd });
  if (tree.status !== 0) throw new Error(`cannot read pinned tree ${cwd}@${commit}: ${tree.stderr.trim()}`);
  return tree.stdout.split('\0').filter(Boolean).map((row) => {
    const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(row);
    if (!match) throw new Error(`malformed pinned tree in ${cwd}`);
    return { mode: match[1]!, type: match[2]!, sha: match[3]!, file: match[4]! };
  });
}

/** The checked-out submodule at `child` must be its own repository, or its object store is not ours to read. */
function assertSubmoduleStore(child: string, sha: string): void {
  const identity = realAdmissionGit(['rev-parse', '--show-toplevel'], { cwd: child });
  if (identity.status !== 0 || resolve(identity.stdout.trim()) !== child)
    throw new Error(`pinned submodule object store unavailable: ${child}@${sha}`);
}

/**
 * P-007 (green-main-cycle-time-2026-10-08#D-036): the most radius test files one ordinary
 * admission's pre-check runs. A wider radius is recorded `skipped` with `over-cap(n/cap)` and
 * the next targeted repair round (P-005) measures it; the pre-check never runs a whole suite.
 */
export const ADMISSION_RADIUS_CAP = 40;

const RADIUS_SOURCE_RE = /\.[cm]?[jt]sx?$/;
/** Directories every Vitest config excludes (`baseExclude`, libs/test-config/src/vitest-config.ts): no suite runs a test there. */
const RADIUS_EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.next', '.papercusp', '_retired']);
/** One `cat-file --batch` per chunk: a whole large workspace in one call overflows the git output buffer. */
const RADIUS_BLOB_CHUNK = 500;
/**
 * Parsed import edges keyed by (path, blob sha), kept across admissions on the long-lived worker.
 * Consecutive admissions share almost every blob, and parsing is the dominant radius cost
 * (measured 2026-10-13: 61-129s to index operator-core's 16k files under load). Only unseen
 * blobs are read and parsed. Cleared whole at the bound rather than LRU-tracked.
 */
const RADIUS_EDGE_CACHE_MAX = 200_000;
const radiusState = pinModuleState<{ edges: Map<string, ParsedEdges> }>(
  '@papercusp/operator-core.release.admission-radius-edges',
  () => ({ edges: new Map() }),
);
/** Test seam: the worker's shared edge cache, to assert reuse and to reset between cases. */
export function admissionRadiusEdgeCache(): Map<string, ParsedEdges> {
  return radiusState.edges;
}
const WORKSPACE_CONFIG_NAMES = new Set([
  'package.json',
  'tsconfig.json',
  'playwright.config.ts',
  'playwright.config.mts',
  'playwright.config.js',
  'playwright.config.mjs',
]);

/** The npm workspaces whose `workspace-task` leg the frozen signature already records red. */
function redWorkspaceLegs(signature: readonly SignatureLike[]): Set<string> {
  const legs = new Set<string>();
  for (const entry of signature) {
    if (entry.kind !== 'workspace-task') continue;
    const fromId = /^(\S+?)\s*::/.exec(entry.id.trim())?.[1];
    legs.add(entry.workspace ?? fromId ?? entry.id.trim());
  }
  return legs;
}

interface PinnedRepo {
  cwd: string;
  commit: string;
  /** Absolute path → blob entry (symlinks included, so `exists` answers truthfully). */
  blobs: Map<string, Entry>;
  /** Absolute gitlink roots inside this repository. */
  gitlinks: Array<{ root: string; sha: string }>;
  /** Absolute directories holding a `package.json` blob: the workspace roots. */
  workspaceRoots: Set<string>;
}

function pinnedRepo(cwd: string, commit: string, entries: Entry[]): PinnedRepo {
  const blobs = new Map<string, Entry>();
  const gitlinks: PinnedRepo['gitlinks'] = [];
  const workspaceRoots = new Set<string>();
  for (const entry of entries) {
    const abs = resolve(cwd, entry.file);
    if (entry.type === 'commit') gitlinks.push({ root: abs, sha: entry.sha });
    else if (entry.type === 'blob') {
      blobs.set(abs, entry);
      if (entry.mode !== '120000' && entry.file.split('/').pop() === 'package.json') workspaceRoots.add(dirname(abs));
    }
  }
  return { cwd, commit, blobs, gitlinks, workspaceRoots };
}

/**
 * P-007 (green-main-cycle-time-2026-10-08#D-036, #D-037): the related-test radius of an
 * ordinary (non-gitlink) admission, selected at the BUILT commit from pinned trees only.
 *
 * Each admitted non-test source is grouped by its owning workspace (nearest directory with a
 * `package.json` blob, descending into a pinned submodule when the path lives in one). Each
 * group gets its own index over that workspace's sources only, with that workspace's tsconfig
 * aliases — a whole-repo index without aliases marks every `@/` importer unresolved, and the
 * selector always picks unresolved tests, so the radius would always overflow the cap.
 * Cross-workspace dependents are out of scope by design; the next targeted round covers them.
 *
 * A radius file is `reportOnly` when its workspace's `workspace-task` leg is already red in
 * the signature (it was not green, so it cannot prove an import), else `guarded`. Every
 * failure to compute is `skipped` with a reason, never a refusal: before P-007 an ordinary
 * admission had no radius at all.
 */
export function ordinaryAdmissionRadius(input: {
  root: string;
  commit: string;
  top: Entry[];
  signature: readonly SignatureLike[];
  admittedPaths: readonly string[];
  cap?: number;
}): AdmissionRadius {
  const cap = input.cap ?? ADMISSION_RADIUS_CAP;
  const root = resolve(input.root);
  const legs: Record<string, string> = {};
  const result = (status: AdmissionRadius['status'], reason: string, detail?: string, guarded: string[] = [], reportOnly: string[] = []): AdmissionRadius => ({
    status,
    reason,
    ...(detail ? { detail } : {}),
    guarded,
    reportOnly,
    legs,
  });
  try {
    const toRel = (abs: string) => relative(root, abs).split(sep).join('/');
    const superRepo = pinnedRepo(root, input.commit, input.top);
    const children = new Map<string, PinnedRepo>();
    const locate = (abs: string): PinnedRepo => {
      let repo = superRepo;
      for (let depth = 0; ; depth += 1) {
        const link = repo.gitlinks.find((candidate) => abs.startsWith(candidate.root + sep));
        if (!link) return repo;
        if (depth >= 8) throw new Error(`pinned submodule nesting exceeds inventory bound at ${link.root}`);
        let child = children.get(link.root);
        if (!child) {
          assertSubmoduleStore(link.root, link.sha);
          child = pinnedRepo(link.root, link.sha, treeAt(link.root, link.sha));
          children.set(link.root, child);
        }
        repo = child;
      }
    };
    const ownerMemo = new Map<string, string | null>();
    const owningWorkspace = (repo: PinnedRepo, abs: string): string | null => {
      const walked: string[] = [];
      let dir = dirname(abs);
      let owner: string | null = null;
      for (;;) {
        const memo = ownerMemo.get(dir);
        if (memo !== undefined) { owner = memo; break; }
        walked.push(dir);
        if (repo.workspaceRoots.has(dir)) { owner = dir; break; }
        if (dir === repo.cwd || !dir.startsWith(repo.cwd + sep)) break;
        dir = dirname(dir);
      }
      for (const step of walked) ownerMemo.set(step, owner);
      return owner;
    };
    const readBlobs = (repo: PinnedRepo, files: readonly string[]): Map<string, string> => {
      const entries = files.map((file) => repo.blobs.get(file)).filter((entry): entry is Entry => !!entry && entry.mode !== '120000');
      const shas = [...new Set(entries.map((entry) => entry.sha))];
      const contents = new Map<string, string>();
      for (let start = 0; start < shas.length; start += RADIUS_BLOB_CHUNK) {
        const batch = readAdmissionBlobBatch(repo.cwd, shas.slice(start, start + RADIUS_BLOB_CHUNK));
        if (!batch.ok) throw new Error(`${repo.cwd}@${repo.commit}: ${batch.step}: ${batch.detail.slice(0, 200)}`);
        for (const [sha, text] of batch.contents) contents.set(sha, text);
      }
      const out = new Map<string, string>();
      for (const file of files) {
        const entry = repo.blobs.get(file);
        const text = entry && entry.mode !== '120000' ? contents.get(entry.sha) : undefined;
        if (text !== undefined) out.set(file, text);
      }
      return out;
    };
    const legNames = new Map<string, string>();
    const legOf = (repo: PinnedRepo, wsRoot: string): string => {
      const known = legNames.get(wsRoot);
      if (known) return known;
      const manifest = readBlobs(repo, [resolve(wsRoot, 'package.json')]).get(resolve(wsRoot, 'package.json'));
      let name: unknown;
      try { name = manifest ? (JSON.parse(manifest) as { name?: unknown }).name : undefined; } catch { name = undefined; }
      const leg = typeof name === 'string' && name.trim() ? name.trim() : toRel(wsRoot) || '.';
      legNames.set(wsRoot, leg);
      return leg;
    };

    const admitted = [...new Set(input.admittedPaths.map((file) => file.trim().replaceAll('\\', '/').replace(/^\.\//, '')).filter(Boolean))];
    const admittedTests = new Set(admitted.filter((file) => isTestFilePath(file) || isTestFile(file)));
    const signatureTests = new Set(input.signature.filter((entry) => entry.kind === 'test-file').map((entry) => entry.id.trim().replaceAll('\\', '/').replace(/^\.\//, '')));
    // Admitted test files carry their leg too, so an imports-red refusal names it.
    for (const file of admittedTests) {
      const abs = resolve(root, file);
      const repo = locate(abs);
      const ws = owningWorkspace(repo, abs);
      if (ws) legs[file] = legOf(repo, ws);
    }
    const sources = admitted.filter((file) => RADIUS_SOURCE_RE.test(file) && !admittedTests.has(file));
    if (sources.length === 0) return result('not-applicable', 'no-source-paths');

    const groups = new Map<string, { repo: PinnedRepo; changed: string[] }>();
    let unowned = 0;
    for (const file of sources) {
      const abs = resolve(root, file);
      const repo = locate(abs);
      const ws = owningWorkspace(repo, abs);
      if (!ws) { unowned += 1; continue; }
      const group = groups.get(ws) ?? { repo, changed: [] };
      group.changed.push(abs);
      groups.set(ws, group);
    }
    if (groups.size === 0) return result('skipped', 'radius-unavailable', `no owning workspace for ${unowned} admitted source path(s)`);

    const redLegs = redWorkspaceLegs(input.signature);
    const radius: Array<{ file: string; leg: string }> = [];
    let playwrightExcluded = 0;
    let unroutable = 0;
    for (const [wsRoot, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const { repo } = group;
      const leg = legOf(repo, wsRoot);
      const wsSources = [...repo.blobs.keys()].filter((file) =>
        RADIUS_SOURCE_RE.test(file) && repo.blobs.get(file)!.mode !== '120000' &&
        !relative(wsRoot, file).split(sep).some((part) => RADIUS_EXCLUDED_DIRS.has(part)) &&
        owningWorkspace(repo, file) === wsRoot);
      const configs = [...repo.blobs.keys()].filter((file) => dirname(file) === wsRoot && WORKSPACE_CONFIG_NAMES.has(file.slice(wsRoot.length + 1)));
      const edgeCache = radiusState.edges;
      if (edgeCache.size > RADIUS_EDGE_CACHE_MAX) edgeCache.clear();
      const blobKey = (file: string): string | null => repo.blobs.get(file)?.sha ?? null;
      const unparsed = wsSources.filter((file) => {
        const key = blobKey(file);
        return !key || !edgeCache.has(edgeCacheKey(file, key));
      });
      const contents = readBlobs(repo, [...unparsed, ...configs]);
      const readFile = (file: string): string => {
        const text = contents.get(file);
        if (text === undefined) throw new Error(`absent at the pinned commit: ${file}`);
        return text;
      };
      const aliases = tsconfigPathEntriesFor(wsRoot, { readFile });
      const fs = {
        list: () => wsSources,
        read: (file: string) => contents.get(file) ?? null,
        key: blobKey,
        // Relative imports may leave the workspace; a path under a pinned gitlink exists by construction.
        exists: (file: string) => repo.blobs.has(file) || repo.gitlinks.some((link) => file.startsWith(link.root + sep)),
      };
      const index = buildIndex({ rootDir: wsRoot, aliases, fs, edgeCache });
      // The widen threshold is the gate's COST rule (an explicit list near the whole suite is pure
      // overhead). Here the cap is the cost rule, and a small workspace whose few tests are all
      // related must stay measured rather than collapse to `full`.
      const selection = selectRelatedTests({
        rootDir: wsRoot, changedPaths: group.changed, aliases, index, fs, judgedSha: input.commit,
        threshold: Number.POSITIVE_INFINITY,
      });
      if (selection.mode === 'full') return result('skipped', `selection-full:${selection.reason}`, `leg ${leg}: the selector could not narrow (${selection.reason}); the next targeted round measures it`);
      const ownedByPlaywright = playwrightOwnedTest(wsRoot, { readFile });
      for (const abs of selection.selected) {
        if (ownedByPlaywright(abs)) { playwrightExcluded += 1; continue; }
        const file = toRel(abs);
        if (signatureTests.has(file) || admittedTests.has(file)) continue;
        if (!isTestFilePath(file)) { unroutable += 1; continue; }
        radius.push({ file, leg });
      }
    }
    const detail = [
      `${groups.size} workspace(s)`,
      ...(playwrightExcluded ? [`playwright-excluded=${playwrightExcluded}`] : []),
      ...(unroutable ? [`unroutable=${unroutable}`] : []),
      ...(unowned ? [`unowned-sources=${unowned}`] : []),
    ].join('; ');
    if (radius.length > cap) return result('skipped', `over-cap(${radius.length}/${cap})`, detail);
    const guarded: string[] = [];
    const reportOnly: string[] = [];
    for (const { file, leg } of radius) {
      legs[file] = leg;
      (redLegs.has(leg) ? reportOnly : guarded).push(file);
    }
    return result('measured', 'ok', detail, guarded, reportOnly);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return result('skipped', 'radius-unavailable', message.slice(0, 400));
  }
}

/** Runs on the admission worker. Neither inventory nor blob reads consult the working tree. */
export async function immutablePrecheckPopulation(input: ImmutablePrecheckInput): Promise<
  | { ok: true; population: FixPrecheckPopulation }
  | { ok: false; detail: string }
> {
  const root = resolve(input.root);
  const unavailable = (detail: string) => ({ ok: false as const, detail });
  try {
    const top = treeAt(root, input.commit);
    const canonicalRoot = await resolveCanonicalIntegrationRoot(root);
    const admitted = new Set(input.admittedPaths.map((file) => file.trim().replaceAll('\\', '/').replace(/^\.\//, '')));
    const gitlinks = top.filter((entry) => entry.type === 'commit' && admitted.has(entry.file));
    // P-007: an ordinary admission adds its related-test radius to the exact admitted files.
    if (gitlinks.length === 0) {
      const radius = ordinaryAdmissionRadius({ root, commit: input.commit, top, signature: input.signature, admittedPaths: input.admittedPaths });
      return { ok: true, population: precheckPopulation({ ...input, radius }) };
    }
    const blobs = new Map<string, string | null>();
    const ownRoots = gitlinks.map((entry) => resolve(root, entry.file));
    const collect = (logicalCwd: string, objectCwd: string, commit: string, entries: Entry[], depth: number): void => {
      if (depth > 8) throw new Error('pinned submodule nesting exceeds inventory bound at ' + logicalCwd);
      const sources = entries.filter((entry) => entry.type === 'blob' && /\.[cm]?[jt]sx?$/.test(entry.file));
      const batch = readAdmissionBlobBatch(objectCwd, [...new Set(sources.filter((entry) => entry.mode !== '120000').map((entry) => entry.sha))]);
      if (!batch.ok) throw new Error(objectCwd + '@' + commit + ': ' + batch.detail);
      for (const entry of entries) {
        if (entry.type === 'blob') blobs.set(resolve(logicalCwd, entry.file), entry.mode === '120000' ? null : batch.contents.get(entry.sha) ?? null);
        else if (entry.type === 'commit') {
          const logicalChild = resolve(logicalCwd, entry.file);
          const objectChild = resolve(objectCwd, entry.file);
          assertSubmoduleStore(objectChild, entry.sha);
          collect(logicalChild, objectChild, entry.sha, treeAt(objectChild, entry.sha), depth + 1);
        }
      }
    };
    collect(root, canonicalRoot, input.commit, top, 0);
    const sources = [...blobs.keys()].filter((file) => /\.[cm]?[jt]sx?$/.test(file));
    const fs = { list: () => sources, read: (file: string) => blobs.get(file) ?? null, exists: (file: string) => blobs.has(file) };
    const index = buildIndex({ rootDir: root, fs });
    // A gitlink moves a directory. Expand it to immutable descendants for the existing selector.
    const changedPaths = [...blobs.keys()].filter((file) => ownRoots.some((own) => file.startsWith(own + sep)));
    const selected = selectRelatedTests({ rootDir: root, changedPaths, index, fs, judgedSha: input.commit });
    const related = selected.mode === 'full' ? sources.filter(isTestFile) : selected.selected;
    const tests = sources.filter((file) => isTestFilePath(file));
    const own = tests.filter((file) => ownRoots.some((own) => file.startsWith(own + sep)));
    const unmeasuredRoots = ownRoots.filter((ownRoot) => !own.some((file) => file.startsWith(ownRoot + sep)));
    if (unmeasuredRoots.length > 0) return unavailable(`admitted gitlink has no discoverable test files: ${unmeasuredRoots.join(', ')}; no test measurement can certify its paired dependencies`);
    // Router spellings absent from the selector's test regex cannot silently disappear.
    const affectedTestFiles = [...new Set([...related, ...own, ...tests.filter((file) => !isTestFile(file))])]
      .map((file) => relative(root, file).split(sep).join('/')).sort();
    return { ok: true, population: precheckPopulation({ ...input, affectedTestFiles }) };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

export type AdmissionJob =
  | { kind: 'git'; argv: string[]; cwd: string }
  | { kind: 'reconcile-lineage'; queue: FrozenCandidateRepairQueue; root: string }
  | { kind: 'precheck-population'; input: ImmutablePrecheckInput }
  | { kind: 'containment'; paths: string[]; judgedSha: string; root: string; branch: string }
  | { kind: 'committed-patch'; input: CommittedPatchInput }
  | { kind: 'hunk-exact'; input: Omit<BuildHunkExactSourceInput, 'git'> }
  | {
      kind: 'admit';
      input: Omit<AdmitPathsInput, 'git' | 'preflight'>;
      preflight: AdmissionPreflightSpec | null;
    }
  | { kind: 'retract'; input: RetractInput };

export interface AdmissionJobResults {
  git: AdmissionGitResult;
  'reconcile-lineage': ReturnType<typeof reconcileFrozenRepairQueueWithLineageRef>;
  'precheck-population': Awaited<ReturnType<typeof immutablePrecheckPopulation>>;
  containment: ReturnType<typeof containmentForPaths>;
  'committed-patch': ReturnType<typeof buildCommittedPatchSource>;
  'hunk-exact': HunkExactSourceOutcome;
  admit: AdmissionOutcome;
  retract: boolean;
}

export type AdmissionJobKind = AdmissionJob['kind'];
export type AdmissionJobOf<K extends AdmissionJobKind> = Extract<AdmissionJob, { kind: K }>;

/** Rebuild the admit door's preflight closure from its plain spec (on whichever thread runs the job). */
export function admissionPreflightFromSpec(
  root: string,
  spec: AdmissionPreflightSpec,
): NonNullable<AdmitPathsInput['preflight']> {
  return chainAdmissionPreflights(
    importCompletenessPreflight({
      root,
      probeRef: spec.probeRef,
      ...(spec.enforceSourceCohort ? { enforceSourceCohort: true } : {}),
    }),
    lockfileManifestConsistencyPreflight({ root, probeRef: spec.probeRef }),
  );
}

/** Run one job against the unchanged builders. Throws exactly what they throw. */
export function executeAdmissionJob<K extends AdmissionJobKind>(job: AdmissionJobOf<K>): Promise<AdmissionJobResults[K]>;
export async function executeAdmissionJob(job: AdmissionJob): Promise<AdmissionJobResults[AdmissionJobKind]> {
  switch (job.kind) {
    case 'git':
      return realAdmissionGit(job.argv, { cwd: job.cwd });
    case 'reconcile-lineage':
      return reconcileFrozenRepairQueueWithLineageRef(job.queue, { root: job.root });
    case 'precheck-population':
      return immutablePrecheckPopulation(job.input);
    case 'containment':
      return containmentForPaths(job.paths, job.judgedSha, job.root, undefined, job.branch);
    case 'committed-patch':
      return buildCommittedPatchSource(job.input);
    case 'hunk-exact':
      return buildHunkExactSource(job.input);
    case 'admit':
      return admitPathsOntoRepairHead({
        ...job.input,
        ...(job.preflight ? { preflight: admissionPreflightFromSpec(job.input.root, job.preflight) } : {}),
      });
    case 'retract':
      return retractAdmission(job.input);
    default: {
      const unknown: never = job;
      throw new Error(`unknown admission job kind: ${String((unknown as { kind?: unknown }).kind)}`);
    }
  }
}

/** Wire messages between the host and the admission worker. */
export type AdmissionWorkerRequest = { id: number; job: AdmissionJob };
export type AdmissionWorkerResponse =
  | { type: 'ready' }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: { name: string; message: string; stack?: string } };

/** Minimal port surface so the worker loop is testable without a real thread. */
export interface AdmissionJobPort {
  on(event: 'message', listener: (message: AdmissionWorkerRequest) => void): unknown;
  postMessage(message: AdmissionWorkerResponse): void;
}

/**
 * The worker-side loop: announce readiness (the host treats any failure BEFORE this as a load
 * failure, never as a job failure), then run each request to completion. A worker thread runs
 * one message handler at a time, so jobs never interleave — the builders' sync invariant holds.
 */
export function serveAdmissionJobs(port: AdmissionJobPort): void {
  let pending = Promise.resolve();
  port.on('message', (request) => {
    pending = pending.then(async () => {
      try {
        const value = await executeAdmissionJob(request.job);
        port.postMessage({ type: 'result', id: request.id, ok: true, value });
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        port.postMessage({
          type: 'result',
          id: request.id,
          ok: false,
          error: { name: e.name, message: e.message, ...(e.stack ? { stack: e.stack } : {}) },
        });
      }
      });
  });
  port.postMessage({ type: 'ready' });
}
