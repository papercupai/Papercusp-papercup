import { papercuspPath } from '@papercusp/host-platform/home';
/**
 * FrontierSWE corpus ingest (plan benchmark-coverage-frontierswe-v2-2026-10-10 P-002; D-002).
 *
 * Replaces the hand-pasted Python heredoc that used to live in grader/FRONTIER-SWE-PILOT.md. It reads a
 * vendored checkout of `Proximal-Labs/frontier-swe-v2` at a PINNED commit as DATA ONLY (task.toml +
 * instruction.md; nothing from the checkout is executed) and produces:
 *
 *  - `tasks.jsonl` — one {@link FrontierSweTaskRow} per task, the shape `task-sets.ts` already loads;
 *  - `manifest.json` — the provenance record: upstream repo, pinned commit, license status, and for EVERY
 *    task the agent image digest plus the verifier image digest.
 *
 * v2 pins every image by `@sha256:` digest inside task.toml (D-002 §3), so the digest is read, never resolved
 * against a registry. A task whose agent or verifier image is not digest-pinned FAILS the ingest: a corpus
 * whose images can float is not a reproducible benchmark (spec FSWE-P002-MANIFEST).
 */
import TOML from '@iarna/toml';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { FRONTIER_SWE_V2_SUITE_CATEGORIES, type FrontierSweArtifact, type FrontierSweTaskRow } from './task-sets';

export const FRONTIER_SWE_V2_REPO = 'Proximal-Labs/frontier-swe-v2';

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /@(sha256:[0-9a-f]{64})$/;

/** The filesystem seam — tests inject an in-memory tree; production uses {@link nodeIngestFs}. */
export interface FrontierSweIngestFs {
  /** Immediate child directory names of `dir` (unsorted is fine). */
  listDirs(dir: string): Promise<string[]>;
  /** File contents, or null when the file does not exist. */
  readText(path: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  /** Immediate child FILE names of `dir` — used to detect a LICENSE file at the checkout root. */
  listFiles(dir: string): Promise<string[]>;
}

/**
 * The git-history seam (D-007): when a task first appeared upstream. Kept apart from {@link FrontierSweIngestFs}
 * because it reads commit history, not files. Tests inject a fake; production uses {@link gitTaskHistory}.
 */
export interface FrontierSweTaskHistory {
  /**
   * ISO-8601 committer date of the earliest commit reachable from `commitSha` that added `relPath`, or null when
   * that cannot be known (shallow checkout, no git, the path was never added). Null is the honest answer: a date
   * read from truncated history would be the truncation point, which makes every task look newer than it is.
   */
  firstAddedAt(relPath: string, commitSha: string): Promise<string | null>;
}

function git(root: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', root, ...args], { timeout: 30_000, maxBuffer: 1 << 20 }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}

/** Production {@link FrontierSweTaskHistory} over a git checkout. Refuses (null for every path) on a shallow clone. */
export function gitTaskHistory(root: string): FrontierSweTaskHistory {
  let shallow: Promise<boolean> | null = null;
  return {
    async firstAddedAt(relPath, commitSha) {
      shallow ??= git(root, ['rev-parse', '--is-shallow-repository']).then((out) => out?.trim() !== 'false');
      if (await shallow) return null;
      const out = await git(root, ['log', '--diff-filter=A', '--format=%cI', '--reverse', commitSha, '--', relPath]);
      const first = out?.split('\n').find((line) => line.trim() !== '')?.trim();
      return first && !Number.isNaN(Date.parse(first)) ? first : null;
    },
  };
}

export interface FrontierSweManifestTask {
  instanceId: string;
  /** The upstream commit this entry was read at — repeated per entry so an entry is self-describing (spec FSWE-P002-MANIFEST). */
  commitSha: string;
  agentImage: string;
  agentImageDigest: string;
  verifierImage: string;
  verifierImageDigest: string;
}

export interface FrontierSweCorpusManifest {
  schemaVersion: 1;
  upstreamRepo: string;
  commitSha: string;
  /** 'none' when the checkout has no LICENSE* file (true for v1 and v2 as of D-002 — research/eval use only). */
  licenseStatus: 'none' | 'present';
  licenseFile: string | null;
  ingestedAt: string;
  taskCount: number;
  tasks: FrontierSweManifestTask[];
}

export interface FrontierSweIngestResult {
  rows: FrontierSweTaskRow[];
  manifest: FrontierSweCorpusManifest;
}

export class FrontierSweIngestError extends Error {
  constructor(
    message: string,
    readonly problems: readonly string[],
  ) {
    super(message);
    this.name = 'FrontierSweIngestError';
  }
}

/** The `sha256:<hex>` digest of a digest-pinned image reference, or null when the reference can float. */
/**
 * First exposure of a task an earlier corpus version already published: the earliest of the two first-add dates,
 * and null whenever the earlier version's date is unknown, because the later date alone would understate exposure.
 */
export function earliestExposure(priorFirstAddedAt: string | null, ownFirstAddedAt: string | null): string | null {
  if (!priorFirstAddedAt || Number.isNaN(Date.parse(priorFirstAddedAt))) return null;
  if (!ownFirstAddedAt || Number.isNaN(Date.parse(ownFirstAddedAt))) return priorFirstAddedAt;
  return Date.parse(ownFirstAddedAt) < Date.parse(priorFirstAddedAt) ? ownFirstAddedAt : priorFirstAddedAt;
}

export function imageDigestOf(image: string | null | undefined): string | null {
  if (!image) return null;
  return DIGEST_RE.exec(image.trim())?.[1] ?? null;
}

/** Coarse implementation|performance|research bucket — the v1 mapping, kept so tier reporting stays comparable. */
export function frontierSweBucket(category: string | undefined, tags: readonly string[] | undefined): FrontierSweTaskRow['tier'] {
  const c = (category ?? '').toLowerCase();
  const t = (tags ?? []).join(' ').toLowerCase();
  if (c === 'ml-research' || c === 'rl-post-training') return 'research';
  if (
    ['optim', 'simd', 'performance'].some((x) => c.includes(x)) ||
    c === 'systems-research' ||
    ['performance', 'optimization', 'compression'].some((x) => t.includes(x))
  ) {
    return 'performance';
  }
  return 'implementation';
}

/**
 * Whether a task.toml network_mode lets the agent reach the network. v2 spells the offline mode 'no-network'
 * (observed at the pinned commit), so 'none' alone is not enough; 'allowlist' is restricted but online.
 */
export function networkAllowsInternet(mode: string | undefined): boolean {
  return mode !== undefined && mode !== 'none' && mode !== 'no-network';
}

/**
 * External services a task's job.yaml runtime profile requires (D-002 §5): a Modal runtime, the Modal VM
 * runtime flag, and any registry pull secret. Returns [] for no profile; throws on a profile that does not parse.
 */
export function frontierSweExternalNeeds(jobYaml: string | null): string[] {
  if (jobYaml === null) return [];
  const env = table(table(parseYaml(jobYaml)).environment);
  const kwargs = table(env.kwargs);
  const needs: string[] = [];
  const type = str(env.type);
  if (type && type !== 'docker') needs.push(`runtime:${type}`);
  if (kwargs.modal_vm_runtime === true) needs.push('modal-vm-runtime');
  const secret = str(kwargs.registry_secret);
  if (secret) needs.push(`registry-secret:${secret}`);
  return needs;
}

/**
 * Label a v1 corpus as HISTORY against a v2 corpus (R-1): every row gets corpusVersion 'v1', and retiredInV2 is
 * true when its exact instanceId is absent from v2. Renames are NOT matched — a renamed successor is a different
 * task, so its v1 row is retired. These rows must never aggregate with v2 rows.
 */
export function labelV1History(v1Rows: readonly FrontierSweTaskRow[], v2Rows: readonly FrontierSweTaskRow[]): FrontierSweTaskRow[] {
  const v2Ids = new Set(v2Rows.map((r) => r.instanceId));
  return v1Rows.map((r) => ({ ...r, corpusVersion: 'v1', retiredInV2: !v2Ids.has(r.instanceId) }));
}

type TomlTable = Record<string, unknown>;
const table = (v: unknown): TomlTable => (v && typeof v === 'object' && !Array.isArray(v) ? (v as TomlTable) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const strList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;

/** The five upstream suite categories (plan D-003 §4) — defined once in task-sets, where the pilot stratifies on them. */
export { FRONTIER_SWE_V2_SUITE_CATEGORIES };

/**
 * Parse the README task table (`| 01 | [Name](tasks/<id>/) | Cat A, Cat B |`) into task id → suite categories.
 * Returns an empty map when the README has no such table. Throws on a category outside the known five, so a
 * renamed category fails the ingest instead of silently dropping a task out of every stratum.
 */
export function parseFrontierSweReadmeCategories(readme: string | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const known = new Set<string>(FRONTIER_SWE_V2_SUITE_CATEGORIES);
  for (const line of (readme ?? '').split('\n')) {
    const m = /^\|\s*\d+\s*\|\s*\[[^\]]*\]\(tasks\/([^/)]+)\/?\)\s*\|\s*([^|]+?)\s*\|\s*$/.exec(line.trim());
    if (!m) continue;
    const cats = m[2].split(',').map((c) => c.trim()).filter(Boolean);
    const unknown = cats.filter((c) => !known.has(c));
    if (unknown.length) throw new Error(`README task '${m[1]}' has unknown suite categor${unknown.length > 1 ? 'ies' : 'y'}: ${unknown.join(', ')}`);
    out.set(m[1], cats);
  }
  return out;
}

/** task.toml `artifacts` (strings or `{ source, exclude }` tables) → normalized entries; malformed entries throw. */
export function frontierSweArtifactsOf(v: unknown): FrontierSweArtifact[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error('artifacts must be an array');
  return v.map((entry, i) => {
    if (typeof entry === 'string') return { source: entry, exclude: [] };
    const t = table(entry);
    const source = str(t.source);
    if (!source) throw new Error(`artifacts[${i}] has no string source`);
    return { source, exclude: strList(t.exclude) ?? [] };
  });
}

/** task.toml [verifier.env] → a string map (non-string values are stringified the way TOML wrote them). */
function verifierEnvOf(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(table(v))) {
    if (typeof val === 'string') out[k] = val;
    else if (typeof val === 'number' || typeof val === 'boolean') out[k] = String(val);
  }
  return out;
}

/**
 * Build the corpus rows + provenance manifest from a vendored checkout root (the directory holding `tasks/`).
 * Throws {@link FrontierSweIngestError} listing EVERY problem (not just the first) when the commit is not a
 * full SHA, a task.toml does not parse, or any task's agent/verifier image is not digest-pinned.
 */
export async function ingestFrontierSweCorpus(
  input: {
    root: string;
    commitSha: string;
    upstreamRepo?: string;
    now?: Date;
    /** Supplies each row's `taskCreatedAt` (D-007). Omitted ⇒ no row carries one ⇒ reports read 'contamination-unknown'. */
    history?: FrontierSweTaskHistory;
    /**
     * An EARLIER corpus version (v1) that already published some of these task ids. A carried-over id was exposed
     * from its first appearance THERE, so its date is the earliest first-add across versions. When the prior
     * version's history cannot supply that date the row carries NO `taskCreatedAt` ('unknown'), never this
     * checkout's later date: v2 added every task in one 2026-09-02 commit, and that date would read post-cutoff
     * for a model that trained on the v1 copy (D-007 item 3, "unknown is never clean").
     */
    priorVersion?: { instanceIds: readonly string[]; history?: FrontierSweTaskHistory; commitSha?: string };
  },
  fs: FrontierSweIngestFs,
): Promise<FrontierSweIngestResult> {
  const problems: string[] = [];
  if (!COMMIT_SHA_RE.test(input.commitSha)) {
    problems.push(`commitSha must be a full 40-hex commit, got '${input.commitSha}'`);
  }
  const prior = input.priorVersion;
  if (prior?.commitSha !== undefined && !COMMIT_SHA_RE.test(prior.commitSha)) {
    problems.push(`priorVersion.commitSha must be a full 40-hex commit, got '${prior.commitSha}'`);
  }
  const priorIds = new Set(prior?.instanceIds ?? []);
  const priorFirstAddedAt = async (name: string): Promise<string | null> =>
    prior?.history && prior.commitSha ? prior.history.firstAddedAt(`tasks/${name}/task.toml`, prior.commitSha) : null;
  const tasksDir = join(input.root, 'tasks');
  const dirs = (await fs.listDirs(tasksDir)).slice().sort();
  const rows: FrontierSweTaskRow[] = [];
  const manifestTasks: FrontierSweManifestTask[] = [];
  let readmeCategories = new Map<string, string[]>();
  try {
    readmeCategories = parseFrontierSweReadmeCategories(await fs.readText(join(input.root, 'README.md')));
  } catch (e) {
    problems.push(`README.md task table: ${e instanceof Error ? e.message : String(e)}`);
  }

  for (const name of dirs) {
    const dir = join(tasksDir, name);
    const tomlText = await fs.readText(join(dir, 'task.toml'));
    if (tomlText === null) continue; // not a task directory
    let cfg: TomlTable;
    try {
      cfg = TOML.parse(tomlText) as TomlTable;
    } catch (e) {
      problems.push(`${name}: task.toml does not parse (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    const task = table(cfg.task);
    const meta = table(cfg.metadata);
    const agent = table(cfg.agent);
    const verifier = table(cfg.verifier);
    const env = table(cfg.environment);
    const verifierEnv = table(verifier.environment);

    const agentImage = str(env.docker_image) ?? '';
    // v1 tasks graded inside the agent container; v2 names a separate verifier image (D-002 §4).
    const verifierImage = str(verifierEnv.docker_image) ?? agentImage;
    const agentImageDigest = imageDigestOf(agentImage);
    const verifierImageDigest = imageDigestOf(verifierImage);
    if (!agentImageDigest) problems.push(`${name}: agent image is not digest-pinned ('${agentImage || '<missing>'}')`);
    if (!verifierImageDigest) {
      problems.push(`${name}: verifier image is not digest-pinned ('${verifierImage || '<missing>'}')`);
    }

    const tags = strList(task.keywords) ?? strList(meta.tags) ?? [];
    const category = str(meta.category);
    const networkMode = str(env.network_mode);
    let externalNeeds: string[] = [];
    try {
      externalNeeds = frontierSweExternalNeeds(await fs.readText(join(dir, 'job.yaml')));
    } catch (e) {
      problems.push(`${name}: job.yaml does not parse (${e instanceof Error ? e.message : String(e)})`);
    }
    let artifacts: FrontierSweArtifact[] = [];
    try {
      artifacts = frontierSweArtifactsOf(cfg.artifacts);
    } catch (e) {
      problems.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
    // A README that HAS a task table must list every task, or that task would silently fall out of every
    // category stratum (D-003 §4). A README without a table (no rows parsed) leaves categories empty.
    const suiteCategories = readmeCategories.get(name) ?? [];
    if (readmeCategories.size > 0 && suiteCategories.length === 0) {
      problems.push(`${name}: missing from the README task table (no suite category)`);
    }
    const verifierEnvironmentMode = str(verifier.environment_mode) === 'separate' ? 'separate' : 'shared';
    const ownFirstAddedAt = input.history
      ? await input.history.firstAddedAt(`tasks/${name}/task.toml`, input.commitSha)
      : null;
    const taskCreatedAt = priorIds.has(name)
      ? earliestExposure(await priorFirstAddedAt(name), ownFirstAddedAt)
      : ownFirstAddedAt;
    rows.push({
      ...(taskCreatedAt ? { taskCreatedAt } : {}),
      instanceId: name,
      category,
      tier: frontierSweBucket(category, tags),
      difficulty: str(meta.difficulty),
      tags,
      prompt: (await fs.readText(join(dir, 'instruction.md'))) ?? '',
      dockerImage: agentImage,
      verifierDockerImage: verifierImage,
      agentTimeoutSec: num(agent.timeout_sec),
      verifierTimeoutSec: num(verifier.timeout_sec),
      cpus: num(env.cpus),
      memoryMb: num(env.memory_mb),
      storageMb: num(env.storage_mb),
      gpus: num(env.gpus) ?? 0,
      gpuTypes: strList(env.gpu_types) ?? [],
      allowInternet: typeof env.allow_internet === 'boolean' ? env.allow_internet : networkAllowsInternet(networkMode),
      networkMode,
      verifierNetworkMode: str(verifierEnv.network_mode) ?? str(verifier.network_mode),
      // The separate verifier's OWN accelerators (can differ from the agent's — multi-gpu-efficient-finetuning).
      verifierGpus: num(verifierEnv.gpus) ?? 0,
      verifierGpuTypes: strList(verifierEnv.gpu_types) ?? [],
      externalNeeds,
      verifierEnvironmentMode,
      verifierEnv: verifierEnvOf(verifier.env),
      artifacts,
      suiteCategories,
      // Harbor's convention: the verifier entrypoint is /tests/test.sh. v2 verifier images own a /tests/test.sh
      // shim that execs the root-only /root/tests/test.sh (D-003 §1) — it does NOT exist in the agent image.
      verifierCmd: 'bash /tests/test.sh',
      rewardPath: '/logs/verifier/reward.txt',
      rewardJsonPath: '/logs/verifier/reward.json',
      solutionCmd: (await fs.exists(join(dir, 'solution', 'solve.sh'))) ? 'bash /solution/solve.sh' : null,
      hasOracle: await fs.exists(join(dir, 'oracle.yaml')),
      corpusVersion: 'v2',
      upstreamCommit: input.commitSha,
      retiredInV2: false,
    });
    if (agentImageDigest && verifierImageDigest) {
      manifestTasks.push({
        instanceId: name,
        commitSha: input.commitSha,
        agentImage,
        agentImageDigest,
        verifierImage,
        verifierImageDigest,
      });
    }
  }

  if (rows.length === 0 && problems.length === 0) problems.push(`no task.toml found under ${tasksDir}`);
  if (problems.length) {
    throw new FrontierSweIngestError(`FrontierSWE ingest refused: ${problems.length} problem(s)`, problems);
  }

  const licenseFile = (await fs.listFiles(input.root)).find((f) => /^licen[sc]e/i.test(f)) ?? null;
  return {
    rows,
    manifest: {
      schemaVersion: 1,
      upstreamRepo: input.upstreamRepo ?? FRONTIER_SWE_V2_REPO,
      commitSha: input.commitSha,
      licenseStatus: licenseFile ? 'present' : 'none',
      licenseFile,
      ingestedAt: (input.now ?? new Date()).toISOString(),
      taskCount: rows.length,
      tasks: manifestTasks,
    },
  };
}

/**
 * The commit a git checkout has checked out, read from `.git` files (no git subprocess): a detached HEAD holds
 * the SHA directly; a symbolic HEAD resolves through `refs/…` then `packed-refs`. Null when unresolvable.
 */
export async function readCheckoutHead(root: string, fs: FrontierSweIngestFs): Promise<string | null> {
  const head = (await fs.readText(join(root, '.git', 'HEAD')))?.trim();
  if (!head) return null;
  if (COMMIT_SHA_RE.test(head)) return head;
  const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
  if (!ref) return null;
  const loose = (await fs.readText(join(root, '.git', ref)))?.trim();
  if (loose && COMMIT_SHA_RE.test(loose)) return loose;
  const packed = (await fs.readText(join(root, '.git', 'packed-refs'))) ?? '';
  for (const line of packed.split('\n')) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === ref && sha && COMMIT_SHA_RE.test(sha)) return sha;
  }
  return null;
}

const toJsonl = (rows: readonly FrontierSweTaskRow[]) => rows.map((r) => JSON.stringify(r) + '\n').join('');

/** Parse a corpus JSONL (one row per non-blank line). */
export function parseFrontierSweJsonl(text: string): FrontierSweTaskRow[] {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as FrontierSweTaskRow);
}

/**
 * Write `tasks.jsonl` + `manifest.json` into `outDir`, plus `v1-history.jsonl` when labelled v1 rows are given.
 * v1 history goes to its own file so no loader that reads `tasks.jsonl` can aggregate it with v2 (R-1).
 */
export async function writeFrontierSweCorpus(
  outDir: string,
  result: FrontierSweIngestResult,
  v1History?: readonly FrontierSweTaskRow[],
): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'tasks.jsonl'), toJsonl(result.rows));
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(result.manifest, null, 2) + '\n');
  if (v1History) await writeFile(join(outDir, 'v1-history.jsonl'), toJsonl(v1History));
}

export function nodeIngestFs(): FrontierSweIngestFs {
  const entries = (dir: string) => readdir(dir, { withFileTypes: true }).catch(() => []);
  return {
    listDirs: async (dir) => (await entries(dir)).filter((e) => e.isDirectory()).map((e) => e.name),
    listFiles: async (dir) => (await entries(dir)).filter((e) => e.isFile()).map((e) => e.name),
    readText: (path) => readFile(path, 'utf8').catch(() => null),
    exists: (path) => stat(path).then(() => true, () => false),
  };
}

export function defaultFrontierSweCorpusDir(): string {
  return papercuspPath('bench-results', 'frontier-swe-v2');
}
