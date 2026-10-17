#!/usr/bin/env node
// scripts/source-preview.mjs — the private source preview (plan dhh-source-preview-2026-09-28).
//
// WHAT IT IS. Invited individuals get READ access to one private GitHub repo,
// Papercusp/papercusp-preview, holding the PUBLIC-SAFE source cut: exactly what every
// desktop installer already ships as sidecar/source.tar.zst (D-003/D-004), minus
// node_modules. It is never the real Papercusp/papercup repo, never its private
// submodule repos, and never git history.
//
// WHAT IT REUSES — there is no second exporter and no second secret list (D-002):
//   selection  papercusp-desktop/bin/lib/source-tree-selection.sh (shared with the
//              installer's bin/stage-source-tree.sh), run through
//              papercusp-desktop/bin/source-tree-select.sh (same GNU tar engine,
//              same audit-owned identity scrub);
//   gate       papercusp-desktop/bin/audit-release-bundle.py — the full bundle audit
//              over a packed copy (forbidden paths + identity + credentials) plus
//              --scan-dir over the directory — with gitleaks and trufflehog as
//              additional detectors. Any finding refuses; a scanner that cannot run
//              refuses (a gate that looked at nothing is not a pass).
//
// WHAT IT ADDS: a CLEAN export of one pinned commit (git archive of the superproject
// and every submodule at its gitlink — no working-tree debris), MANIFEST.json,
// NOTICE, README.md, and a drift-checked, gated, single-commit publish.
//
// Usage:
//   node scripts/source-preview.mjs export [--ref main] [--out <dir>]
//   node scripts/source-preview.mjs gate <dir>
//   node scripts/source-preview.mjs check [--ref main] [--remote <url>]
//   node scripts/source-preview.mjs push  [--ref main] [--remote <url>] [--confirm]
//   node scripts/source-preview.mjs licenses [--json <file>]
// npm: preview:export · preview:gate · preview:check · preview:push
// Every command takes --target preview|public (default preview). The public target
// (plan open-source-release-2026-09-29) publishes to Papercusp/papercusp-app under the
// Elastic License 2.0, APPEND-ONLY; the preview is replaced wholesale. See TARGETS.
//
// PAPERCUSP_RELEASE_OWNER_NAME (and _EMAIL) must be exported — read at run time, never
// written anywhere — exactly as for a release cut: the scrub and the gate refuse
// without them.
//
// PAPERCUSP_UPDATE_BASE_URL names the release host whose index.html is the releases
// page README.md links to. It is deployment state, never committed here: the CLI fills
// it from ~/.papercusp/release-host.env (the file the release scripts load) when unset,
// and the export refuses without it rather than publish a README with no download link.
//
// Exit: 0 ok / in sync · 1 finding / drift / refused · 2 usage or cannot check.
import assert from 'node:assert/strict';
import { committedWorkRootDependencyDonor } from './lint-as-committed.mjs';
import { readTaskDeadlineEpochMs, formatTaskDeadlineRefusal } from './lib/budgeted-task-scheduler.mjs';
import { createProgressAwareWatchdog } from './lib/batch-watchdog.mjs';
import { processGroupLifetime } from '@papercusp/operator-core/lib/fleet/process-group-lifetime';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, appendFileSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { constants, homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { verifierSourceFiles, verifierGitCheckoutSync, verifyVerifierSourceSync as verifyArchivedSourceSync, VerifierSourceError, writeVerifierTaskReceipt } from '@papercusp/operator-core/lib/verifier-source';
import { NOTICES_FILE, collectThirdPartyNotices } from './check-licenses.mjs';
import { runTreeRestrictedHoldPreflight, formatTreeRestrictedHoldRefusal,
  RESTRICTED_HOLD_PREFLIGHT_ENV, RESTRICTED_HOLD_PREFLIGHT_ADMITTED_BY_ROUTER } from './lib/restricted-hold-preflight.mjs';
import { applyEnvLocal, PG_URL_ENV_VARS } from './lib/pg-url.mjs';
import { findUnusableRuntimeDeps, formatRuntimeFailures } from './check-declared-deps-extracted.mjs';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const PREVIEW_REPO = 'Papercusp/papercusp-preview';
// NOT 'Papercusp/papercusp': that name is the private libs/papercusp library repo
// (open-source-release-2026-09-29 D-016), and an append push there would stack the export
// on top of the library's own history.
export const PUBLIC_REPO = 'Papercusp/papercusp-app';
export const SOURCE_REPO = 'Papercusp/papercup';
export const DEFAULT_REMOTE = `https://github.com/${PREVIEW_REPO}.git`;
export const DEFAULT_REF = 'main';
/** The public target's license (Elastic License 2.0, plan open-source-release-2026-09-29 D-003). */
export const PUBLIC_LICENSE_PATH = join(ROOT, 'scripts', 'public-release', 'LICENSE');

/**
 * Where an export is published (plan open-source-release-2026-09-29 P-002/P-003).
 * - preview: the private, invite-only evaluation snapshot. Replaced WHOLESALE by one
 *   parentless commit on every push, so no history accumulates there.
 * - public: the open-source repository. APPEND-ONLY: every export is committed on top of
 *   the current public main and pushed without --force, so forks, clones and pull
 *   requests keep a history they can rebase onto. It must never be the preview repo:
 *   the preview's earlier force-pushed snapshots stay fetchable by SHA.
 * @typedef {{ key: 'preview' | 'public', repo: string, history: 'replace' | 'append', purpose: string, email: string }} Target
 * @type {Record<'preview' | 'public', Target>}
 */
export const TARGETS = {
  preview: { key: 'preview', repo: PREVIEW_REPO, history: 'replace', purpose: 'private source preview — public-safe cut (plan dhh-source-preview-2026-09-28)', email: 'source-preview@papercusp.invalid' },
  public: { key: 'public', repo: PUBLIC_REPO, history: 'append', purpose: 'public source release — public-safe cut (plan open-source-release-2026-09-29)', email: 'public-export@papercusp.invalid' },
};

/** @param {string} [name] @returns {Target} */
export function resolveTarget(name = 'preview') {
  const t = TARGETS[/** @type {'preview' | 'public'} */ (name)];
  if (!t) throw new PreviewError(`unknown target ${name} (expected ${Object.keys(TARGETS).join(' | ')})`, 2);
  return t;
}

/** @param {Target} target */
export const defaultRemote = (target) => `https://github.com/${target.repo}.git`;

/**
 * Refuse a remote that names the OTHER target's repository: pushing the public cut into the
 * preview would flip nothing but mislabel it, and the preview's --force replace would erase
 * the public history everyone forked from.
 * @param {Target} target @param {string} remote
 */
export function assertRemoteMatchesTarget(target, remote) {
  const repoOf = (r) => r.replace(/\.git$/, '').replace(/\/+$/, '').split(/[/:]/).slice(-2).join('/').toLowerCase();
  const named = repoOf(remote);
  // Private repositories no target may ever publish to: the source superproject and the
  // libs/papercusp library repo, which owns the name 'Papercusp/papercusp' (D-016).
  for (const privateRepo of [SOURCE_REPO, 'Papercusp/papercusp']) {
    if (named === privateRepo.toLowerCase()) {
      throw new PreviewError(`remote ${remote} is the private repository ${privateRepo} — refusing to publish the ${target.key} target there`, 2);
    }
  }
  for (const other of Object.values(TARGETS)) {
    if (other.key !== target.key && named === other.repo.toLowerCase()) {
      throw new PreviewError(`remote ${remote} is the ${other.key} repository (${other.repo}) — refusing to publish the ${target.key} target there`, 2);
    }
  }
}
const DESKTOP_BIN = join(ROOT, 'papercusp-desktop', 'bin');
export const SELECT_SCRIPT = join(DESKTOP_BIN, 'source-tree-select.sh');
export const SELECTION_LIB = join(DESKTOP_BIN, 'lib', 'source-tree-selection.sh');
export const AUDIT_SCRIPT = join(DESKTOP_BIN, 'audit-release-bundle.py');
/** Files this script adds at the export root, outside the shared selection. */
export const ADDED_FILES = ['NOTICE', 'README.md', 'MANIFEST.json'];
/** The Tauri desktop shell, shipped only by the public target (P-004). */
export const DESKTOP_DIR = 'papercusp-desktop';
/**
 * What the public target leaves out of the desktop shell (GNU tar patterns, relative to
 * the shell root): generated sidecar copies, build output, local agent state and stray
 * files, and the internal VM/cloud test rigs, which drive the maintainers' own machines.
 */
export const DESKTOP_PUBLIC_EXCLUDES = [
  './src-tauri/env-sidecars',
  './src-tauri/target',
  './node_modules',
  './.papercusp',
  './.papercup-console-active.*',
  './b',
  './bin/vm-rig',
  './bin/deb-hetzner-*',
  './bin/mac-vm-*',
  './scripts/linux-test-vm',
  './scripts/windows-vm',
];
/**
 * Community-health files the public target copies verbatim from scripts/public-release/
 * (plan open-source-release-2026-09-29 P-007). Every one is required: a public repo
 * without a disclosure path or contribution terms is not recoverable once cloned.
 */
export const PUBLIC_COMMUNITY_FILES = [
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  // P-011: the agreement CONTRIBUTING.md promises, and the bot that asks for it.
  'CLA.md',
  '.github/workflows/cla.yml',
  // P-009: the public repository's own CI — the private repo's workflows never ship.
  '.github/workflows/ci.yml',
];
/** The public target also adds its LICENSE, the community files, and THIRD-PARTY-NOTICES.md
 *  (generated from the export's own lockfiles by check-licenses.mjs — P-017 step 5). */
export const PUBLIC_ADDED_FILES = [...ADDED_FILES, 'LICENSE', ...PUBLIC_COMMUNITY_FILES, NOTICES_FILE];
/** Top-level entries the added files create (`.github` for the workflows) — the README's
 *  tree listing describes the development tree, not these. */
const PUBLIC_ADDED_TOPS = new Set(PUBLIC_ADDED_FILES.map((f) => f.split('/')[0]));
/** The env var holding the release host base URL; `${base}/index.html` is the releases page. */
export const RELEASE_BASE_ENV = 'PAPERCUSP_UPDATE_BASE_URL';
/** Where the release scripts keep that value (papercusp-desktop/bin/lib/release-host.sh). */
export const RELEASE_HOST_ENV_PATH = join(homedir(), '.papercusp', 'release-host.env');

/** @typedef {{ name: string, ok: boolean, status: string, detail: string }} GateResult */
/** @typedef {{ detector: string, rule: string, path: string, line: number, sha256: string, allowlisted?: boolean }} GateFinding */
/** @typedef {{ ok: boolean, exitCode: number, results: GateResult[], findings?: GateFinding[] }} GateVerdict */
/** @typedef {(dir: string, opts: { env?: NodeJS.ProcessEnv }) => Promise<GateVerdict>} Gate */
/** @typedef {(message: string) => void} Log */

export class PreviewError extends Error {
  /** @param {string} message @param {number} [exitCode] */
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** Run a command, returning stdout; throw PreviewError with stderr on failure. */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.error) throw new PreviewError(`${cmd} failed to start: ${r.error.message}`, 2);
  if (r.status !== 0) {
    throw new PreviewError(`${cmd} ${args.join(' ')} exited ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(-2000)}`);
  }
  return r.stdout;
}

const git = (repo, args, opts) => run('git', ['-C', repo, ...args], opts);

/** Read GitHub JSON plus pagination headers without requiring a recent gh CLI. */
function githubPage(endpoint) {
  const raw = run('gh', ['api', '--include', endpoint]).replace(/\r\n/g, '\n');
  const boundary = raw.indexOf('\n\n');
  if (boundary < 0) throw new PreviewError('GitHub response has no HTTP header boundary', 2);
  const headers = Object.fromEntries(raw.slice(0, boundary).split('\n').slice(1).map((line) => {
    const colon = line.indexOf(':');
    return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
  }));
  return { headers, body: JSON.parse(raw.slice(boundary + 2)) };
}

/**
 * R13: inspect the current public population and actual default-branch license bytes.
 * Reuses the public export's canonical ELv2 and the maintained Apache library text.
 * Unknown text, an API failure, incomplete pagination or a changed population refuses.
 * GitHub's license metadata is supplementary; it is never the license oracle.
 * @typedef {{ path: string, gitBlob: string, sha256: string, license: string | null, url: string }} PublicRepositoryLicense
 * @typedef {{ repo: string, defaultBranch: string, metadataSpdx: string | null, head: string | null, licenses: PublicRepositoryLicense[], errors: string[] }} PublicRepositoryLicenseRow
 */
/**
 * @param {{ api?: (endpoint: string) => Promise<{ headers: Record<string, string>, body: any }> | { headers: Record<string, string>, body: any }, licenseHashes?: Record<string, string>, libraryRepositories?: string[], log?: Log }} [options]
 */
export async function auditPublicRepositoryLicenses({ api = githubPage, licenseHashes, libraryRepositories, log = () => {} } = {}) {
  const startedAt = new Date().toISOString();
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const reviewed = licenseHashes ?? {
    [digest(readFileSync(PUBLIC_LICENSE_PATH))]: 'ELv2',
    [digest(readFileSync(join(ROOT, 'libs/generic/cache/LICENSE')))]: 'Apache-2.0',
    // Existing SideStage-mobile MIT declaration, read and reviewed in the R13 census.
    '84ea0f54f720885e4e0a6d2e45baca5a7d6e30aa26db12eabbeda4b3b48c3ea7': 'MIT',
  };
  if (!libraryRepositories) {
    // Derive the library policy from the existing registry, never a remembered count.
    const modules = new Map();
    const config = run('git', ['config', '--file', join(ROOT, '.gitmodules'), '--get-regexp', '^submodule\\..*\\.(path|url)$']);
    for (const line of config.trim().split('\n')) {
      const space = line.indexOf(' ');
      const key = line.slice(0, space);
      const dot = key.lastIndexOf('.');
      const name = key.slice(0, dot);
      const module = modules.get(name) ?? {};
      module[key.slice(dot + 1)] = line.slice(space + 1);
      modules.set(name, module);
    }
    libraryRepositories = [...modules.values()].filter((module) => module.path?.startsWith('libs/generic/') || ['libs/agent-chat', 'libs/testing-shell', 'libs/test-config'].includes(module.path)).map((module) => module.url.replace(/^git@github\.com:/, '').replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, ''));
  }
  const libraries = new Set(libraryRepositories.map((repo) => repo.toLowerCase()));
  async function population() {
    const repositories = [];
    const pages = [];
    const seen = new Set();
    let endpoint = 'orgs/Papercusp/repos?type=public&per_page=100&page=1';
    while (endpoint) {
      if (seen.has(endpoint)) throw new PreviewError('GitHub pagination repeated a page', 2);
      seen.add(endpoint);
      const { headers, body } = await api(endpoint);
      if (!Array.isArray(body)) throw new PreviewError('GitHub population is not an array', 2);
      for (const repo of body) {
        if (!/^Papercusp\/[A-Za-z0-9._-]+$/i.test(repo.full_name ?? '') || repo.private !== false || !repo.default_branch) {
          throw new PreviewError('GitHub population contains an invalid public repository', 2);
        }
        if (repositories.some((r) => r.full_name.toLowerCase() === repo.full_name.toLowerCase())) {
          throw new PreviewError(`GitHub population repeats ${repo.full_name}`, 2);
        }
        repositories.push(repo);
      }
      const link = headers.link ?? '';
      const next = link.split(',').find((part) => /rel="next"/.test(part));
      const url = next?.match(/<([^>]+)>/)?.[1];
      if (next && !url?.startsWith('https://api.github.com/orgs/Papercusp/repos?')) {
        throw new PreviewError('GitHub next-page link is missing or outside the population endpoint', 2);
      }
      pages.push({ endpoint, size: body.length, next: url ?? null });
      endpoint = url ? url.slice('https://api.github.com/'.length) : '';
    }
    if (!repositories.length) throw new PreviewError('GitHub public population is empty', 2);
    return { repositories, pages };
  }
  const first = await population();
  /** @type {PublicRepositoryLicenseRow[]} */
  const rows = [];
  /** @type {Record<string, string>} */
  const licenseTexts = {};
  for (const repo of first.repositories) {
    log(`license census: ${repo.full_name} default=${repo.default_branch}`);
    /** @type {PublicRepositoryLicenseRow} */
    const row = { repo: repo.full_name, defaultBranch: repo.default_branch, metadataSpdx: repo.license?.spdx_id ?? null, head: null, licenses: [], errors: [] };
    try {
      const { body: commit } = await api(`repos/${row.repo}/commits/${encodeURIComponent(row.defaultBranch)}`);
      if (!/^[a-f0-9]{40}$/.test(commit.sha ?? '')) throw new Error('default branch has no measured commit');
      row.head = commit.sha;
      const { body: root } = await api(`repos/${row.repo}/contents?ref=${row.head}`);
      if (!Array.isArray(root)) throw new Error('default-branch root was not measured');
      const candidates = root.filter((f) => f.type === 'file' && /^(?:licen[cs]e|copying)(?:\.(?:md|txt))?$/i.test(f.name));
      if (!candidates.length) throw new Error('default branch has no root license file');
      for (const file of candidates) {
        const { body: content } = await api(`repos/${row.repo}/contents/${encodeURIComponent(file.path)}?ref=${row.head}`);
        if (content.encoding !== 'base64' || typeof content.content !== 'string') throw new Error(`license bytes unavailable: ${file.path}`);
        const bytes = Buffer.from(content.content, 'base64');
        if (bytes.toString('base64') !== content.content.replace(/\s/g, '')) throw new Error(`invalid license base64: ${file.path}`);
        const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        if (blob !== content.sha || blob !== file.sha) throw new Error(`license blob mismatch: ${file.path}`);
        const sha256 = digest(bytes);
        const license = reviewed[sha256] ?? null;
        licenseTexts[sha256] = bytes.toString('utf8');
        row.licenses.push({ path: file.path, gitBlob: blob, sha256, license, url: `https://github.com/${row.repo}/blob/${row.head}/${file.path}` });
        if (!license) row.errors.push(`unreviewed license text: ${file.path}`);
        if (license && libraries.has(row.repo.toLowerCase()) && license !== 'Apache-2.0' && license !== 'MIT') {
          row.errors.push(`D-003 requires a permissive library license: ${file.path}`);
        }
        if (license && (row.repo.toLowerCase() === PUBLIC_REPO.toLowerCase() || ['goals', 'cupboard-actions', 'blueprints', 'sidestage', 'scout-runtime', 'recipes', 'plans', 'scout-chat', 'drawer-stack', 'cart-drawer', 'data-fetch'].includes(row.repo.split('/')[1].toLowerCase())) && license !== 'ELv2') {
          row.errors.push(`D-011/D-023 require ELv2: ${file.path}`);
        }
      }
    } catch (error) {
      row.errors.push(error instanceof Error ? error.message : String(error));
    }
    rows.push(row);
  }
  const last = await population();
  const identity = (repos) => repos.map((r) => `${r.full_name}:${r.default_branch}`).sort().join('\n');
  const stablePopulation = identity(first.repositories) === identity(last.repositories);
  const assertions = [
    { id: 'complete-stable-population', passed: stablePopulation, evidence: 'Both population reads followed every next-page link to a terminal page. Exact page receipts are in pagination; both repository/default-branch populations must agree.' },
    { id: 'actual-default-branch-license-bytes', passed: rows.every((row) => !row.errors.length), evidence: 'Every repository is enumerated in rows with its measured default-branch commit, root license blob and SHA-256. Any missing/unreadable/unreviewed/mismatched license fails this assertion; full errors remain on the affected row.' },
  ];
  const exitCode = assertions.every((assertion) => assertion.passed) ? 0 : 1;
  return { schemaVersion: 1, kind: 'operational-test-evidence', name: 'Public repository default-branch license census', framework: 'operational', command: ['node --import tsx scripts/source-preview.mjs licenses'], startedAt, finishedAt: new Date().toISOString(), exitCode, evidencePlane: 'live', summary: `${rows.length} public repositories; ${rows.filter((row) => row.errors.length).length} license failures; population ${stablePopulation ? 'stable' : 'changed'}`, assertions, pagination: { first: first.pages, last: last.pages }, rows, licenseTexts };
}

/** Resolve a ref to a full commit SHA in `repo`. */
export function resolveCommit(repo, ref) {
  return git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();
}

/** Every gitlink (submodule pin) recorded in `sha`'s tree: [{ path, sha }]. */
export function listGitlinks(repo, sha) {
  const out = git(repo, ['ls-tree', '-r', '-z', sha]);
  const links = [];
  for (const entry of out.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    const [mode, type, obj] = entry.slice(0, tab).split(' ');
    if (mode === '160000' && type === 'commit') links.push({ path: entry.slice(tab + 1), sha: obj });
  }
  return links;
}

/** The shared top-level allowlist, read from the selection library itself. */
export function allowlistTops(selectionLib = SELECTION_LIB) {
  const out = run('bash', ['-c', '. "$1"; printf "%s\\n" $SOURCE_TREE_ALLOWLIST', '_', selectionLib]);
  const tops = out.split('\n').map((s) => s.trim()).filter(Boolean);
  if (tops.length === 0) throw new PreviewError(`empty allowlist from ${selectionLib}`, 2);
  return new Set(tops);
}

function extractArchive(repo, sha, dest) {
  run('bash', ['-c', 'set -euo pipefail; git -C "$1" archive --format=tar "$2" | tar -xf - -C "$3"', '_', repo, sha, dest]);
}

function materializedSubmodule(repo, link, full) {
  const subRepo = join(repo, link.path);
  const known = existsSync(subRepo)
    && spawnSync('git', ['-C', subRepo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim() === realpathSync(subRepo)
    && spawnSync('git', ['-C', subRepo, 'cat-file', '-e', `${link.sha}^{commit}`]).status === 0;
  if (!known) {
    throw new PreviewError(`unresolvable gitlink ${full} @ ${link.sha} — its commit is not present in ${subRepo}; run \`git submodule update --init\` or fetch it, then retry`);
  }
  return subRepo;
}

// Resolve only the tested path's gitlinks, against their pinned commits. An
// unrelated unresolved gitlink must not hide an initial dirty-input refusal.
function committedInputBlob(repo, sha, path, trees) {
  const key = `${repo}\0${sha}`;
  if (!trees.has(key)) {
    const entries = new Map();
    const links = [];
    for (const row of git(repo, ['ls-tree', '-r', '-z', sha]).split('\0')) {
      if (!row) continue;
      const tab = row.indexOf('\t');
      const name = row.slice(tab + 1);
      const fields = row.slice(0, tab).split(' ');
      entries.set(name, fields);
      if (fields[0] === '160000') links.push({ path: name, sha: fields[2] });
    }
    trees.set(key, { entries, links });
  }
  const { entries, links } = trees.get(key);
  const link = links.find((entry) => path.startsWith(`${entry.path}/`));
  if (link) return committedInputBlob(materializedSubmodule(repo, link, link.path),
    link.sha, path.slice(link.path.length + 1), trees);
  const [mode, type, blob] = entries.get(path) ?? [];
  if (type !== 'blob' || !['100644', '100755'].includes(mode)) {
    throw new PreviewError(`tested input is not a regular committed file: ${path}`, 2);
  }
  return blob;
}

/** Conservative allocated source bytes for the exact recursive verifier export.
 * Count committed blobs, including desktop and private gitlinks, before creating
 * any destination. Per-file block rounding covers small-file allocation; the
 * existing disk reservation adds its separate dependency/metadata allowance.
 * export-ignore can only make the actual archive smaller than this census.
 */
export function measureVerifierSourceBytes({ repo, ref }) {
  const measure = (source, sha, prefix = '') => {
    let bytes = 0;
    for (const entry of git(source, ['ls-tree', '-r', '-z', '-l', sha]).split('\0')) {
      if (!entry) continue;
      const fields = entry.slice(0, entry.indexOf('\t')).trim().split(/\s+/);
      if (fields[1] !== 'blob') continue;
      const size = Number(fields[3]);
      if (!Number.isSafeInteger(size) || size < 0) throw new PreviewError('cannot measure committed source bytes', 2);
      bytes += Math.ceil(size / 4096) * 4096;
    }
    for (const link of listGitlinks(source, sha)) {
      const full = prefix ? `${prefix}/${link.path}` : link.path;
      bytes += measure(materializedSubmodule(source, link, full), link.sha, full);
    }
    if (!Number.isSafeInteger(bytes)) throw new PreviewError('committed source size exceeds safe integer range', 2);
    return bytes;
  };
  return measure(repo, resolveCommit(repo, ref));
}

/**
 * Materialize `sha` of `repo` into `dest` from git objects only (no working-tree
 * files), recursing into every submodule whose top-level entry the allowlist ships.
 * An unresolvable gitlink REFUSES: silently exporting a hole would publish a tree
 * that is not the commit the manifest names.
 * @returns {{ path: string, sha: string }[]} the submodules materialized
 */
export function materializeCommit({ repo, sha, dest, allow, prefix = '' }) {
  extractArchive(repo, sha, prefix ? join(dest, prefix) : dest);
  const subs = [];
  for (const link of listGitlinks(repo, sha)) {
    const full = prefix ? `${prefix}/${link.path}` : link.path;
    if (!allow.has(full.split('/')[0])) continue;
    // The submodule must be its OWN checkout: an uninitialised submodule is an
    // empty dir inside the parent, where `git -C` would silently answer for the
    // parent repository instead.
    const subRepo = materializedSubmodule(repo, link, full);
    const target = join(dest, full);
    // git archive leaves the gitlink as an empty directory; make sure it exists.
    run('mkdir', ['-p', target]);
    subs.push({ path: full, sha: link.sha });
    subs.push(...materializeCommit({ repo: subRepo, sha: link.sha, dest, allow, prefix: full }));
  }
  return subs;
}

/** Internal verification export: no public selection, scrub, publish or working-tree overlay.
 * The caller retains this receipt outside the export, then verifies it before execution.
 * @param {{repo: string, ref: string, dest: string, inputs?: string[], inputsFile?: string, gitCheckout?: boolean}} options
 */
// Shared by early e2e admission and the native snapshot. Explicit caller
// acceptance paths remain required; this tooling profile cannot replace them.
export const TAURI_VERIFIER_INPUTS = Object.freeze([
  'package.json',
  'package-lock.json',
  'papercusp-desktop/package.json',
  'papercusp-desktop/package-lock.json',
  'scripts/npm-install-safe.mjs',
  'scripts/verify-tauri-headless.sh',
  'scripts/lib/run-in-isolated-netns.sh',
  'packages/operator-core/lib/testing-playwright-reporter.ts',
  'packages/operator-core/lib/testing-native-runtime.ts',
  'packages/operator-core/lib/process-identity.ts',
  'apps/operator/e2e/_fake-llm-fixture.ts',
  'apps/operator/e2e/_fake-llm-fixture-child.ts',
  'apps/operator/bin/bundle-host.sh',
  'apps/operator/bin/bundle-host-common.sh',
  'scripts/source-preview.mjs',
  'scripts/lib/committed-source-loader.mjs',
  'scripts/restricted-hold-tree-gate.mjs',
  'scripts/lib/spa-require-built.sh',
  'scripts/lib/budgeted-task-scheduler.mjs',
  'scripts/lib/task-cgroup-limits.mjs',
  'scripts/pc-heavy.sh',
  'apps/operator/bin/release/dependency-generation.sh',
  'papercusp-desktop/bin/tauri-guarded',
  'papercusp-desktop/bin/lib/claim-target-dir.sh',
  'papercusp-desktop/bin/lib/cargo-target-root.sh',
  'papercusp-desktop/bin/lib/release-artifacts.sh',
  'papercusp-desktop/bin/lib/federation-asserts.sh',
  'papercusp-desktop/bin/lib/disk-preflight.sh',
  'papercusp-desktop/bin/lib/pinned-deps.sh',
  'papercusp-desktop/src-tauri/src/main.rs',
  'papercusp-desktop/src-tauri/src/native_console.rs',
  'papercusp-desktop/src-tauri/src/wsl_sidecar_staging.rs',
  'papercusp-desktop/test/native-console-gnome.test.mjs',
  'papercusp-desktop/test/monorepo-host-preflight.mjs',
  'scripts/lib/node-test-host-preflight.mjs',
  'packages/operator-core/lib/gnome-terminal-policy.json',
]);

/** Validate the explicit tested source population against its pinned commit.
 * @param {{ repo: string, ref: string, inputs?: string[], inputsFile?: string, tauriInputs?: boolean }} options
 */
export async function validateVerifierInputs({ repo, ref, inputs = [], inputsFile, tauriInputs = false }) {
  if (inputsFile !== undefined) {
    const listed = JSON.parse(await fs.readFile(inputsFile, 'utf8'));
    if (!Array.isArray(listed) || !listed.length || listed.some((path) => typeof path !== 'string')) {
      throw new PreviewError('verification inputs file must contain a non-empty JSON array of paths', 2);
    }
    inputs = [...inputs, ...listed];
  }
  if (!inputs.length) throw new PreviewError('verification export needs explicit tested inputs', 2);
  if (tauriInputs) inputs = [...inputs, ...TAURI_VERIFIER_INPUTS];
  const paths = [...new Set(inputs)].sort();
  for (const path of paths) {
    if (path === 'apps/operator/dist-verify' || path.startsWith('apps/operator/dist-verify/')) {
      throw new PreviewError(`generated verifier runtime output cannot be a tested source input: ${path}`, 2);
    }
    if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\0')
      || path.split('/').some((p) => p === '..' || p === '.' || !p)) {
      throw new PreviewError(`invalid tested input: ${path}`, 2);
    }
  }
  const sha = resolveCommit(repo, ref);
  // Refuse initial mismatches before creating a destination, cloning or
  // archiving. Keep the post-copy comparison below as the race guard.
  const inputTrees = new Map();
  for (const path of paths) {
    const live = join(repo, path);
    if (!(await fs.lstat(live)).isFile()) {
      throw new PreviewError(`tested input is not a regular file: ${path}`, 2);
    }
    const blob = committedInputBlob(repo, sha, path, inputTrees);
    const bytes = await fs.readFile(live);
    // Git's raw blob identity includes its object header; do not apply filters.
    const digest = createHash(blob.length === 64 ? 'sha256' : 'sha1')
      .update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (digest !== blob) {
      throw new PreviewError(`dirty tested-input mismatch: ${path}`, 2);
    }
  }
  return { sha, paths };
}

/** Prepare a source snapshot only after all declared inputs match their pin.
 * @param {{ repo: string, ref: string, dest: string, inputs?: string[], inputsFile?: string, gitCheckout?: boolean, tauriInputs?: boolean, operatorApi?: { root: string, sourceReceiptPath: string, sourceReceiptSha256: string, inputReceiptPath: string, inputReceiptSha256: string, outputPath: string } }} options
 */
export async function prepareVerifierSource({ repo, ref, dest, inputs = [], inputsFile, gitCheckout = false, tauriInputs = false, operatorApi }) {
  repo = realpathSync(repo);
  if (existsSync(dest)) throw new PreviewError('verification export destination already exists', 2);
  const { sha, paths } = await validateVerifierInputs({ repo, ref, inputs, inputsFile, tauriInputs });
  // Observations come from a separately selected root, never this exporter.
  const planned = operatorApi ? readOperatorApiHandoff(operatorApi, sha) : undefined;
  if (operatorApi) {
    if (realpathSync(operatorApi.root) === realpathSync(repo))
      throw new PreviewError('operator-api inputs require an independent selected root', 2);
    if (existsSync(operatorApi.outputPath)) throw new PreviewError('operator-api handoff destination already exists', 2);
    assertOutsideArchive(dest, operatorApi.outputPath);
    for (const path of paths) assert.ok(planned.source.testedInputs.some(input => input.path === path),
      `Operator-api selected tested input missing: ${path}`);
  }
  if (gitCheckout) {
    // Reuse the guarded local clone: detached exact ref, borrowed objects, local
    // submodule pins, no origins, and cleanup only of its own new destination.
    const { createScratchClone } = await import('@papercusp/operator-core/lib/scratch-git-clone');
    // A retained materialized reader borrows its physical donor's ignored
    // scratch directory. Clone that donor at the already validated exact pin;
    // keep the reader as the input and receipt identity below.
    await createScratchClone({ source: committedWorkRootDependencyDonor(repo), ref: sha,
      destination: dest, includeSubmodules: true });
  } else await fs.mkdir(dest, { recursive: !operatorApi });
  let handoffIdentity;
  try {
    // Unlike the public export, verification includes desktop/helper gitlinks too.
    const allow = new Set(git(repo, ['ls-tree', '--name-only', sha]).trim().split('\n'));
    const submodules = gitCheckout
      ? [...function* collect(source, commit, prefix = '') {
        for (const link of listGitlinks(source, commit)) {
          const path = prefix ? `${prefix}/${link.path}` : link.path;
          yield { path, sha: link.sha };
          yield* collect(join(source, link.path), link.sha, path);
        }
      }(repo, sha)]
      : materializeCommit({ repo, sha, dest, allow });
    // The verifier rebuilds this private runtime with the maintained bundler.
    // Older commits may contain generated output despite today's gitignore.
    // Never record those mutable artifacts as immutable source in an archive.
    // A Git checkout must retain its tracked population, so refuse that route
    // rather than removing tracked files or weakening its source attestation.
    const runtimeOutput = join(dest, 'apps/operator/dist-verify');
    if (gitCheckout && (await fs.readdir(runtimeOutput).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })).length) {
      throw new PreviewError('committed verifier runtime output requires archive export, not Git checkout', 2);
    }
    if (!gitCheckout) await fs.rm(runtimeOutput, { recursive: true, force: true });
    const testedInputs = [];
    for (const path of paths) {
      const archived = join(dest, path);
      const live = join(repo, path);
      if (!(await fs.lstat(archived)).isFile() || !(await fs.lstat(live)).isFile()) {
        throw new PreviewError(`tested input is not a regular file: ${path}`, 2);
      }
      const digest = createHash('sha256').update(await fs.readFile(archived)).digest('hex');
      if (digest !== createHash('sha256').update(await fs.readFile(live)).digest('hex')) {
        throw new PreviewError(`dirty tested-input mismatch: ${path}`, 2);
      }
      testedInputs.push({ path, sha256: digest });
    }
    const checkout = gitCheckout ? verifierGitCheckoutSync(dest, sha, submodules) : undefined;
    const gitMetadataPaths = checkout ? ['.git', ...submodules.map(row => `${row.path}/.git`)] : [];
    const sourceManifest = { schemaVersion: 'verifier-source-v1', sourceCommit: sha, submodules,
      ...(checkout ? { gitCheckout: checkout } : {}), testedInputs, files: verifierSourceFiles(dest, { gitMetadataPaths }) };
    // Declared, not inferred: the operator-api branch below adds operatorApiInputs after
    // construction, and JS inference would otherwise drop it from the returned receipt type.
    /** @type {typeof sourceManifest & { operatorApiInputs?: { path: string, sha256: string } }} */
    const manifest = sourceManifest;
    if (planned) {
      assert.deepEqual(manifest.files, planned.source.files, 'Operator-api selected source census differs');
      assert.deepEqual(manifest.submodules, planned.source.submodules, 'Operator-api selected submodules differ');
      assert.deepEqual(manifest.testedInputs, planned.source.testedInputs, 'Operator-api selected tested inputs differ');
      // Copy already-materialized bytes. Never install, borrow ambient modules,
      // dereference links or replace a dependency tree recorded as source.
      assert.ok(!existsSync(join(dest, 'node_modules')), 'Operator-api archive already contains dependencies');
      await fs.cp(join(operatorApi.root, 'node_modules'), join(dest, 'node_modules'),
        { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
      assert.deepEqual(verifierSourceFiles(join(dest, 'node_modules')), planned.inputs.dependencyFiles,
        'Operator-api copied materialized dependency census differs');
      readOperatorApiHandoff(operatorApi, sha); // Pins and donor bytes must survive the copy.
      manifest.operatorApiInputs = { path: resolve(operatorApi.outputPath), sha256: operatorApi.inputReceiptSha256 };
    }
    await fs.writeFile(join(dest, '.verifier-source.json'), `${JSON.stringify(manifest)}\n`, { flag: 'wx' });
    if (gitCheckout) {
      // This exporter owns the independent Git directory. Ignore only its
      // generated receipt, keeping arbitrary untracked source visible to the
      // ordinary test reporters' before/after Git probes. Receipt integrity is
      // still checked independently by verifyVerifierSource.
      await fs.appendFile(join(dest, '.git/info/exclude'), '\n/.verifier-source.json\n');
    }
    if (planned) {
      // Check the complete archive again after asynchronous copying, before
      // publishing any handoff. The earlier census is not a copy-time guard.
      verifyArchivedSourceSync(dest, manifest, { runtimeArtifacts: true });
      assertOutsideArchive(dest, operatorApi.outputPath);
      const output = await fs.open(operatorApi.outputPath, 'wx', 0o600);
      try {
        handoffIdentity = await output.stat();
        await output.writeFile(planned.bytes);
      } finally { await output.close(); }
      verifyVerifierSourceSync(dest, manifest);
      readOperatorApiHandoff(operatorApi, sha);
    }
    return manifest;
  } catch (error) {
    // A failed write or final attestation must not leave our partial handoff.
    // Never unlink an existing file that lost the exclusive-create race, or a
    // replacement with a different identity.
    if (handoffIdentity) {
      const current = await fs.lstat(operatorApi.outputPath).catch(error => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (current?.dev === handoffIdentity.dev && current?.ino === handoffIdentity.ino)
        await fs.unlink(operatorApi.outputPath);
    }
    await fs.rm(dest, { recursive: true, force: true });
    if (error instanceof VerifierSourceError) throw new PreviewError(error.message, 2);
    throw error;
  }
}

/** @typedef {<T>(phase: string, operation: () => T | Promise<T>) => Promise<T>} VerifierPhaseRunner */

/** Append outside the owned tree synchronously: a blocked event loop or SIGKILL
 * must leave the last started phase readable without claiming it completed.
 * @param {string} path
 * @param {NodeJS.ProcessEnv} env
 * @returns {VerifierPhaseRunner}
 */
function verifierPhaseRunner(path, env) {
  writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
  const started = performance.now();
  let sequence = 0;
  const record = (phase, event, fields = {}) => appendFileSync(path, `${JSON.stringify({
    schemaVersion: 'verifier-phase-v1', sequence: ++sequence,
    taskId: env.PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID ?? null,
    phase, event, elapsedMs: Math.round(performance.now() - started), ...fields,
  })}\n`);
  return async (phase, operation) => {
    const before = performance.now();
    record(phase, 'started');
    try {
      const result = await operation();
      record(phase, 'completed', { durationMs: Math.round(performance.now() - before),
        ...(phase === 'child.run' ? { exitCode: result } : {}) });
      return result;
    } catch (error) {
      record(phase, 'failed', { durationMs: Math.round(performance.now() - before),
        error: String(error?.message ?? error).slice(0, 2000) });
      throw error;
    }
  };
}

/** Run a bounded dependency preflight without abandoning writers in its owned tree.
 * The maintained helpers emit measured byte, lock and completed-tree counters;
 * only increases extend the watchdog. Join its process group before cleanup.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, timeoutMs?: number, maxMs?: number,
 *   stallWindowMs?: number, extensionMs?: number, signal?: AbortSignal }} options
 */
export async function runVerifierDependencyCommand(command, args, { cwd, env,
  timeoutMs = 600_000, maxMs = 1_800_000, stallWindowMs = 150_000, extensionMs = 60_000, signal }) {
  if (signal?.aborted) throw new PreviewError('verifier dependency preflight canceled before launch', 2);
  const deadline = readTaskDeadlineEpochMs(env);
  if (deadline !== null) maxMs = Math.min(maxMs, deadline - Date.now() - 10_000);
  if (maxMs <= 0) throw new PreviewError('verifier dependency preflight has no task budget remaining', 2);
  const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'] });
  const lifetime = processGroupLifetime(child, message => process.stderr.write(`${message}\n`));
  let stdout = '', stderr = '', pending = '';
  const counters = new Map();
  let termination;
  let terminationReason;
  let rejectAborted;
  const aborted = new Promise((_, reject) => { rejectAborted = reject; });
  const terminate = reason => {
    if (termination) return;
    terminationReason = reason;
    termination = lifetime.terminate({ graceMs: 1_000, killWaitMs: 5_000 });
    termination.then(() => rejectAborted(new PreviewError(reason, 2)), error => {
      error.retainVerifierTree = true;
      rejectAborted(error);
    });
  };
  const watchdog = createProgressAwareWatchdog({ timeoutMs: Math.min(timeoutMs, maxMs), maxMs,
    stallWindowMs, extensionMs,
    onExtend: () => process.stderr.write('VERIFIER_DEPENDENCY_PROGRESS watchdog extended on advancing dependency counters\n'),
    onKill: decision => terminate(`verifier dependency preflight timed out: ${decision.reason}`) });
  const collect = (stream, chunk) => {
    const text = chunk.toString();
    if (stream === 'stdout') stdout = (stdout + text).slice(-4 * 1024 * 1024);
    else stderr = (stderr + text).slice(-4 * 1024 * 1024);
    process[stream].write(chunk);
    pending += text;
    const lines = pending.split('\n');
    pending = lines.pop().slice(-4096);
    for (const line of lines) {
      const counter = /((?:checksum read|copy) progress:.*?) (?:written|read)=(\d+)MiB/.exec(line)
        ?? /(copy lock progress:.*?) advances=(\d+)/.exec(line)
        ?? /^(snapshot progress:) completed=(\d+)(?: |$)/.exec(line);
      if (counter && Number(counter[2]) > (counters.get(counter[1]) ?? 0)) {
        counters.set(counter[1], Number(counter[2]));
        watchdog.noteProgress();
      }
    }
  };
  child.stdout.on('data', chunk => collect('stdout', chunk));
  child.stderr.on('data', chunk => collect('stderr', chunk));
  const closed = new Promise((done, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => done({ code, signal }));
  });
  const onAbort = () => terminate('verifier dependency preflight canceled');
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    const result = await Promise.race([closed, aborted]);
    await Promise.race([lifetime.waitForExit({ timeoutMs: maxMs }), aborted]);
    if (terminationReason) throw new PreviewError(terminationReason, 2);
    if (result.code !== 0 || result.signal)
      throw new PreviewError(`verifier dependency preflight failed: ${stderr || stdout || result.signal || result.code}`, 2);
    return stdout;
  } catch (error) {
    if (child.pid !== undefined) {
      if (!termination) termination = lifetime.terminate({ graceMs: 1_000, killWaitMs: 5_000 });
      try { await termination; }
      catch (exitError) {
        exitError.retainVerifierTree = true;
        throw new AggregateError([error, exitError], `${error.message}; ${exitError.message}`,
          { cause: Object.assign(exitError, { retainVerifierTree: true }) });
      }
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    watchdog.stop();
  }
}

/** Attach dependencies to the independently invoked tree before its first Node
 * command. Reuse the release helper's donor install mutex and private snapshot.
 * @param {{ donor: string, dest: string, receipt: Awaited<ReturnType<typeof prepareVerifierSource>>, runPhase?: VerifierPhaseRunner, signal?: AbortSignal }} options
 */
export async function prepareVerifierDependencies({ donor, dest, receipt, runPhase = async (_phase, operation) => operation(), signal }) {
  await runPhase('deps.source.before', () => verifyVerifierSource(dest, receipt));
  const env = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' };
  const run = (command, args) => runVerifierDependencyCommand(command, args, { cwd: dest, env, signal });
  const copyMode = (await fs.stat(donor)).dev === (await fs.stat(dest)).dev ? 'hardlink' : 'copy';
  await runPhase('deps.snapshot', () => run('bash', [join(dest, 'papercusp-desktop/bin/lib/pinned-deps.sh'),
    'snapshot-locked', realpathSync(donor), realpathSync(dest), copyMode]));
  await runPhase('deps.source.after-snapshot', () => verifyVerifierSource(dest, receipt, { runtimeArtifacts: true }));
  const script = join(dest, 'scripts/source-preview.mjs');
  // The CLI imports workspace TypeScript, including extensionless and directory
  // imports. Resolve its loader from the private snapshot, never ambient options.
  const nodeArgs = ['--import', 'tsx', script];
  await runPhase('deps.inputs', () => run(process.execPath, [...nodeArgs, 'verifier-inputs-check', '--repo', dest,
    '--ref', receipt.sourceCommit, '--inputs', receipt.testedInputs.map(input => input.path).join(',')]));
  await runPhase('deps.measure', async () => {
    const bytes = (await run(process.execPath, [...nodeArgs, 'verifier-measure', '--repo', dest,
      '--ref', receipt.sourceCommit])).trim();
    if (!/^\d+$/.test(bytes) || Number(bytes) <= 0)
      throw new PreviewError('verifier dependency preflight returned no source size', 2);
  });
  await runPhase('deps.source.after-preflight', () => verifyVerifierSource(dest, receipt, { runtimeArtifacts: true }));
  return runPhase('deps.census', () => captureVerifierDependencies({ dest, receipt }));
}

/** Measure installed bytes, not lockfile intent. Reuse the release helper's
 * product-owned tree population and the source verifier's exact file census.
 * Workspace link targets still need source verification; this receipt does
 * not claim final transformed code or a complete runtime import closure.
 * @param {{ dest: string, receipt: Awaited<ReturnType<typeof prepareVerifierSource>> }} options
 */
export function captureVerifierDependencies({ dest, receipt }) {
  const root = realpathSync(dest);
  const result = spawnSync('bash', [join(root, 'papercusp-desktop/bin/lib/pinned-deps.sh'), 'trees', root],
    { cwd: root, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }, encoding: 'utf8',
      timeout: 60_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0)
    throw new PreviewError(`verifier dependency enumeration failed: ${result.error?.message || result.stderr || result.status}`, 2);
  const paths = result.stdout.trim().split('\n').filter(Boolean).sort();
  assert.ok(paths.length > 0 && paths.length <= 1000 && new Set(paths).size === paths.length,
    'Verifier dependency tree population missing or duplicated');
  const policyPath = 'apps/operator/bin/release/dependency-generation.sh';
  const policy = { path: policyPath,
    sha256: createHash('sha256').update(readFileSync(join(root, policyPath))).digest('hex') };
  const trees = paths.map(path => {
    assert.ok(!isAbsolute(path) && !path.includes('\\') &&
      !path.split('/').some(part => !part || part === '.' || part === '..') &&
      path.split('/').at(-1) === 'node_modules' &&
      !paths.some(other => path.startsWith(`${other}/`)), 'Invalid verifier dependency tree');
    const tree = join(root, path);
    assert.ok(lstatSync(tree).isDirectory() && realpathSync(tree) === tree,
      `Verifier dependency tree must be independent: ${path}`);
    // Use the generation writer's population, including its exact ephemeral
    // output policy. A second cache-name list would eventually disagree with
    // the immutable install whose bytes this verifier is meant to measure.
    const records = spawnSync('bash', ['-c',
      'source "$1" || exit; records=$(mktemp) || exit; trap \'rm -f -- "$records" "$records.unsorted"\' EXIT; dependency_generation_source_records "$2" "$records" || exit; cat "$records"',
      'verifier-dependency-records', join(root, policyPath), tree],
    { cwd: root, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }, encoding: 'utf8',
      timeout: 120_000, maxBuffer: 128 * 1024 * 1024 });
    if (records.error || records.status !== 0)
      throw new PreviewError(`verifier dependency census failed: ${records.error?.message || records.stderr || records.status}`, 2);
    // The final link-target column is empty for regular files/directories.
    // Trimming whitespace would erase that field from the final record.
    const population = records.stdout.split('\n').filter(Boolean).map(line => line.split('\t'));
    assert.ok(population.every(row => row.length === 10 && ['d', 'f', 'l'].includes(row[1])),
      'Invalid verifier dependency generation records');
    const files = verifierSourceFiles(tree, { symlinkRoot: root,
      includedPaths: new Set(population.map(row => row[0])) });
    assert.equal(files.length, population.filter(row => row[1] !== 'd').length,
      'Verifier dependency population changed during census');
    return { path, files };
  });
  return { schemaVersion: 'verifier-dependencies-v1', scope: 'materialized-dependency-files',
    root, sourceCommit: receipt.sourceCommit, policy,
    sourceReceiptSha256: createHash('sha256').update(JSON.stringify(receipt)).digest('hex'), trees };
}

/** Admit against the caller's disclosure ledger before leaving its checkout.
 * Frozen source excludes local operator configuration. Preserve its database
 * pins in the child environment so governed admission uses the same control
 * plane, without copying the config file or unrelated secrets into the archive.
 * Explicit database pins and isolated PG selection keep their precedence.
 * @param {{ repo: string, env?: NodeJS.ProcessEnv, preflight?: typeof runTreeRestrictedHoldPreflight }} options
 * @returns {NodeJS.ProcessEnv}
 */
export function verifierCommandAdmissionEnv({ repo, env = process.env, preflight = runTreeRestrictedHoldPreflight }) {
  const verdict = preflight({ roots: [repo], env });
  if (verdict.verdict === 'refuse')
    throw new PreviewError(formatTreeRestrictedHoldRefusal('verifier-run', verdict), 3);
  const childEnv = verdict.verdict === 'admit'
    ? { ...env, [RESTRICTED_HOLD_PREFLIGHT_ENV]: RESTRICTED_HOLD_PREFLIGHT_ADMITTED_BY_ROUTER }
    : { ...env };
  // Resolve while the caller's .env.local still exists. A frozen child otherwise
  // discovers a different desktop cluster when its dedicated queue client opens.
  if (!PG_URL_ENV_VARS.some(key => childEnv[key]))
    applyEnvLocal({ root: join(repo, 'apps', 'operator'), env: childEnv });
  return childEnv;
}

/** Freeze source and dependencies before invoking a command that allocates fixtures.
 * The receipt survives outside the owned tree; only this invocation's tree is removed.
 * @param {{ repo: string, ref: string, receiptPath: string, inputs?: string[], inputsFile?: string, tauriInputs?: boolean, command: string[], env?: NodeJS.ProcessEnv, budgetFrom?: string, childEstimateMs?: number }} options
 * @returns {Promise<number>}
 */
export async function runVerifierCommand({ repo, ref, receiptPath, inputs = [], inputsFile, tauriInputs = false, command, env = process.env, budgetFrom, childEstimateMs = 0 }) {
  if (!ref?.trim() || !receiptPath || !command?.length || !command[0])
    throw new PreviewError('verifier command needs an explicit ref, external receipt and command', 2);
  if (!Number.isSafeInteger(childEstimateMs) || childEstimateMs < 0)
    throw new PreviewError('verifier child estimate must be a nonnegative integer', 2);
  const sourceRepo = realpathSync(repo);
  env = verifierCommandAdmissionEnv({ repo: sourceRepo, env });
  const donor = committedWorkRootDependencyDonor(sourceRepo);
  // Keep hardlinks beside a donor on a data device. A donor on the root device
  // must use the admitted data scratch instead; pinned-deps already supports
  // independent cross-device copies and checks their headroom before copying.
  let scratch = join(donor, '.papercusp', 'scratch');
  if (process.platform === 'linux' && (await fs.stat(donor)).dev === (await fs.stat('/')).dev) {
    const data = await fs.realpath('/mnt/data');
    const dataDevice = (await fs.stat(data)).dev;
    if (dataDevice === (await fs.stat('/')).dev)
      throw new PreviewError('verifier command requires a separate /mnt/data filesystem', 2);
    scratch = join(data, 'tmp');
    await fs.mkdir(scratch, { recursive: true });
    scratch = await fs.realpath(scratch);
    if ((await fs.stat(scratch)).dev !== dataDevice)
      throw new PreviewError('verifier command scratch resolves outside the data filesystem', 2);
  }
  await fs.mkdir(scratch, { recursive: true });
  const taskReceiptPath = `${resolve(receiptPath)}.task.json`;
  const cancellation = new AbortController();
  let cancellationSignal;
  const cancel = signal => {
    cancellationSignal ??= signal;
    cancellation.abort();
  };
  const onInt = () => cancel('SIGINT'), onTerm = () => cancel('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  let owned;
  try { owned = await fs.mkdtemp(join(scratch, 'verifier-command-')); }
  catch (error) {
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
    throw error;
  }
  const root = join(owned, 'invoked-source');
  const checkCancellation = () => {
    if (cancellationSignal)
      throw new PreviewError(`verifier command canceled by ${cancellationSignal}`,
        128 + constants.signals[cancellationSignal]);
  };
  let ownership;
  /** @type {VerifierPhaseRunner} */
  let runPhase = async (_phase, operation) => operation();
  let failure;
  try {
    assertOutsideArchive(owned, resolve(receiptPath));
    ownership = writeVerifierTaskReceipt(owned, sourceRepo, env, taskReceiptPath);
    const tracedPhase = verifierPhaseRunner(`${resolve(receiptPath)}.phases.jsonl`, env);
    const measurements = {};
    runPhase = async (phase, operation) => {
      // Synchronous archive/census work delays JS signal delivery. Yield before
      // admitting the next phase, so a pending cancellation cannot start tests.
      if (phase !== 'cleanup') {
        await new Promise(resolve => setImmediate(resolve));
        checkCancellation();
      }
      const before = performance.now();
      const result = await tracedPhase(phase, operation);
      measurements[phase] = Math.ceil(performance.now() - before);
      if (phase !== 'cleanup') {
        await new Promise(resolve => setImmediate(resolve));
        checkCancellation();
      }
      return result;
    };
    await runPhase('source.admission', () => {
      const estimate = budgetFrom
        ? estimateVerifierCommandBudget(readVerifierPhaseMeasurements(budgetFrom), childEstimateMs)
        : null;
      admitVerifierCommandBudget(estimate, { env, preparation: true });
    });
    const receipt = await runPhase('source.freeze', () => prepareVerifierSource({ repo: sourceRepo, ref, dest: root,
      inputs, inputsFile, tauriInputs, gitCheckout: true }));
    await runPhase('receipt.write', () => fs.writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o600 }));
    const dependencies = await prepareVerifierDependencies({ donor, dest: root, receipt, runPhase, signal: cancellation.signal });
    await runPhase('deps.receipt.write', () => fs.writeFile(`${receiptPath}.dependencies.json`,
      `${JSON.stringify(dependencies)}\n`, { flag: 'wx', mode: 0o600 }));
    await runPhase('child.admission', () => admitVerifierCommandBudget(
      estimateVerifierCommandBudget(measurements, childEstimateMs), { env }));
    const childEnv = await runPhase('child.preflight', () => verifierSourceChildEnv({ root, receiptPath,
        env: { ...env, PAPERCUSP_REPO_DIR: root, NODE_OPTIONS: '', NODE_PATH: '',
          VERIFY_TAURI_SOURCE_INPUTS: receipt.testedInputs.map(input => input.path).join(',') } }));
    const exitCode = await runPhase('child.run', async () => {
      const child = spawn(command[0], command.slice(1), { cwd: root, env: childEnv,
        detached: process.platform !== 'win32', stdio: 'inherit' });
      const lifetime = processGroupLifetime(child, message => process.stderr.write(`${message}\n`));
      let termination;
      const onAbort = () => {
        termination ??= lifetime.terminate({ graceMs: 1_000, killWaitMs: 5_000 });
        // Keep a rejection handled while the child's close notification is pending.
        termination.catch(() => {});
      };
      try {
        /** @type {Promise<number>} */
        const closed = new Promise((done, reject) => {
          child.once('error', reject);
          child.once('close', (code, signal) => done(code ?? (128 + (constants.signals[signal] || 0))));
        });
        cancellation.signal.addEventListener('abort', onAbort, { once: true });
        if (cancellation.signal.aborted) onAbort();
        const code = await closed;
        await (termination ?? lifetime.waitForExit({ timeoutMs: 60_000 }));
        return code;
      } catch (error) {
        try { await (termination ?? lifetime.terminate({ graceMs: 1_000, killWaitMs: 5_000 })); }
        catch (exitError) {
          throw new AggregateError([error, exitError], `${error.message}; ${exitError.message}`,
            { cause: Object.assign(exitError, { retainVerifierTree: true }) });
        }
        throw error;
      } finally {
        cancellation.signal.removeEventListener('abort', onAbort);
      }
    });
    await runPhase('deps.postverify', async () => {
      const after = captureVerifierDependencies({ dest: root, receipt });
      // Keep the actual final census even on drift; never overwrite the
      // original observation with a reconstructed matching receipt.
      await fs.writeFile(`${receiptPath}.dependencies.after.json`, `${JSON.stringify(after)}\n`,
        { flag: 'wx', mode: 0o600 });
      assert.deepEqual(after, dependencies, 'Verifier materialized dependencies changed during command');
    });
    await runPhase('source.postverify', () => verifyVerifierSource(root, receipt, { runtimeArtifacts: true }));
    return exitCode;
  } catch (error) {
    // Cancellation is a signal outcome, not a successful test or a generic
    // preflight error; preserve any unverified-writer retention fence.
    if (cancellationSignal) {
      failure = new PreviewError(`verifier command canceled by ${cancellationSignal}`,
        128 + constants.signals[cancellationSignal]);
      if (error.retainVerifierTree || error.cause?.retainVerifierTree) failure.retainVerifierTree = true;
      throw failure;
    }
    failure = error;
    throw error;
  } finally {
    let cleanup = 'pending';
    try {
      // An unverified exit is not permission to race a live writer. The task's
      // retained ownership receipt lets the existing reconciler clean it later.
      if (failure?.retainVerifierTree || failure?.cause?.retainVerifierTree) {
        cleanup = 'deferred';
        process.stderr.write(`VERIFIER_CLEANUP_DEFERRED unverified process exit: ${owned}\n`);
      } else {
        let cleaned = false;
        try {
          try {
            await runPhase('cleanup', async () => {
              await fs.rm(owned, { recursive: true, force: true });
              cleaned = true;
            });
          } finally {
            // A phase-receipt IO failure must never prevent owned-tree cleanup.
            if (!cleaned) {
              await fs.rm(owned, { recursive: true, force: true });
              cleaned = true;
            }
            cleanup = 'completed';
          }
        } catch (cleanupError) {
          cleanup = cleaned ? 'completed' : 'failed';
          if (failure) throw new AggregateError([failure, cleanupError],
            `${failure.message}; verifier cleanup failed: ${cleanupError.message}`);
          throw cleanupError;
        }
      }
    } finally {
      try {
        if (ownership) {
          const next = `${taskReceiptPath}.${process.pid}.tmp`;
          try {
            await fs.writeFile(next, `${JSON.stringify({ ...ownership, cleanup,
              ...(cancellationSignal ? { cancellationSignal } : {}) })}\n`, { flag: 'wx', mode: 0o600 });
            await fs.rename(next, taskReceiptPath);
          } finally { await fs.rm(next, { force: true }); }
        }
      } finally {
        process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
      }
    }
    checkCancellation();
  }
}

/** Fail closed on absent/changed provenance or any modified/extra/missing source byte.
 * @param {string} dest
 * @param {Awaited<ReturnType<typeof prepareVerifierSource>>} expected
 * @param {{ runtimeArtifacts?: boolean }} [options] Source-only runtime mode permits
 * named untracked build outputs and materialized dependency directories, not source edits.
 */
export async function verifyVerifierSource(dest, expected, options = {}) {
  return verifyVerifierSourceSync(dest, expected, options);
}

/** Synchronous boundary for hooks such as Playwright onBegin, whose return
 * value is not awaited. Uses the same source population and receipt checks.
 * @param {string} dest
 * @param {Awaited<ReturnType<typeof prepareVerifierSource>>} expected
 * @param {{ runtimeArtifacts?: boolean }} [options]
 */
export function verifyVerifierSourceSync(dest, expected, options = {}) {
  try {
    const result = verifyArchivedSourceSync(dest, expected,
      expected?.operatorApiInputs ? { ...options, runtimeArtifacts: true } : options);
    if (expected.operatorApiInputs) {
      assertOutsideArchive(dest, expected.operatorApiInputs.path);
      const bytes = pinnedReceiptBytes(expected.operatorApiInputs.path, expected.operatorApiInputs.sha256);
      assertOperatorApiPlannedInputs(dest, expected, JSON.parse(String(bytes)));
    }
    return result;
  } catch (error) {
    if (error instanceof VerifierSourceError) throw new PreviewError(error.message, 2);
    throw error;
  }
}

/** Validate the existing producer's planned contract without inventing an
 * observed import, schema or environment pin from static source membership. */
function assertOperatorApiPlannedInputs(root, source, inputs) {
  assert.equal(inputs?.phase, 'planned', 'Operator-api independent planned inputs are required');
  assert.equal(inputs.sourceCommit, source.sourceCommit, 'Operator-api selected source differs');
  for (const key of ['testPaths', 'helperPaths', 'configPaths', 'executedImports', 'copiedSources',
    'dependencyFiles', 'copiedArtifacts', 'omitted', 'opaque'])
    assert.ok(Array.isArray(inputs[key]), `Operator-api required dimension missing: ${key}`);
  assert.deepEqual(inputs.omitted, [], 'Operator-api required dimensions omitted');
  assert.deepEqual(inputs.opaque, [], 'Operator-api required dimensions opaque');
  const files = new Map(source.files.map(file => [file.path, file]));
  const sourcePath = path => {
    assert.ok(typeof path === 'string' && path && !isAbsolute(path) && !path.includes('\\')
      && !path.split('/').some(part => !part || part === '.' || part === '..'), 'Invalid operator-api source path');
    assert.ok(files.has(path), `Operator-api source outside selected archive: ${path}`);
    assert.ok(isInside(realpathSync(root), realpathSync(join(root, path))), `Operator-api source escapes archive: ${path}`);
  };
  for (const key of ['testPaths', 'helperPaths', 'configPaths', 'executedImports'])
    assert.ok(inputs[key].length, `Operator-api required observation missing: ${key}`);
  for (const path of [...inputs.testPaths, ...inputs.helperPaths, ...inputs.configPaths,
    ...inputs.executedImports, ...inputs.copiedSources]) sourcePath(path);
  for (const path of inputs.testPaths) assert.ok(source.testedInputs.some(input => input.path === path
    && input.sha256 === files.get(path).sha256), `Operator-api test missing from selected tested inputs: ${path}`);
  for (const key of ['schema', 'environment', 'externalResolutions'])
    assert.ok(inputs[key] && typeof inputs[key] === 'object' && !Array.isArray(inputs[key]),
      `Operator-api required dimension missing: ${key}`);
  for (const key of ['schema', 'environment']) {
    assert.ok(Object.keys(inputs[key]).length, `Operator-api required observation missing: ${key}`);
    for (const value of Object.values(inputs[key])) assert.ok(typeof value === 'string' && value,
      `Operator-api invalid observation: ${key}`);
  }
  for (const value of Object.values(inputs.environment)) assert.match(value, /^[a-f0-9]{64}$/,
    'Operator-api environment digest missing');
  assert.ok(inputs.dependencyFiles.length, 'Operator-api materialized dependencies missing');
  const modules = join(root, 'node_modules');
  assert.ok(lstatSync(modules).isDirectory(), 'Operator-api dependencies must be an independent directory');
  assert.deepEqual(verifierSourceFiles(modules), inputs.dependencyFiles, 'Operator-api materialized dependency census differs');
  for (const file of inputs.dependencyFiles) if (file.kind === 'symlink')
    assert.ok(isInside(realpathSync(modules), realpathSync(join(modules, file.path))),
      `Operator-api dependency symlink escapes materialized tree: ${file.path}`);
  const dependencies = new Set(inputs.dependencyFiles.map(file => `node_modules/${file.path}`));
  for (const path of Object.values(inputs.externalResolutions)) assert.ok(dependencies.has(path),
    `Operator-api external resolution lacks dependency pin: ${path}`);
  const copies = new Map();
  for (const copy of inputs.copiedArtifacts) {
    sourcePath(copy.sourcePath);
    assert.ok(typeof copy.path === 'string' && copy.path && !isAbsolute(copy.path) && !copy.path.includes('\\')
      && !copy.path.split('/').some(part => !part || part === '.' || part === '..'), 'Invalid operator-api artifact path');
    assert.ok(!['operator-api-preflight.json', 'operator-api-inputs.json', 'verifier-source.json',
      'hono-host.mjs', 'hono-host.mjs.meta.json', 'operator-api-build.log'].includes(copy.path)
      && !copies.has(copy.path), 'Reserved or duplicate operator-api artifact path');
    copies.set(copy.path, copy.sourcePath);
  }
  assert.deepEqual([...new Set(copies.values())].sort(), [...new Set(inputs.copiedSources)].sort(),
    'Operator-api copied source census differs');
}

function prospectiveRealpath(path, links = new Set()) {
  const absolute = resolve(path);
  try { return realpathSync(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    let stat;
    try { stat = lstatSync(absolute); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) {
      assert.ok(!links.has(absolute), 'Operator-api receipt path has a symlink cycle');
      links.add(absolute);
      return prospectiveRealpath(resolve(dirname(absolute), readlinkSync(absolute)), links);
    }
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(prospectiveRealpath(parent, links), basename(absolute));
  }
}

function assertOutsideArchive(root, path) {
  // Resolve missing ancestors and dangling links as well as existing parents;
  // the export root may not have been allocated yet.
  assert.ok(!isInside(prospectiveRealpath(root), prospectiveRealpath(path)),
    'Operator-api receipt must be outside the archive');
}

function pinnedReceiptBytes(path, expected) {
  assert.match(expected ?? '', /^[a-f0-9]{64}$/, 'Operator-api receipt digest is required');
  const bytes = readFileSync(path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, 'Pinned operator-api receipt changed');
  return bytes;
}

function readOperatorApiHandoff(options, selectedCommit) {
  assertOutsideArchive(realpathSync(options.root), options.sourceReceiptPath);
  assertOutsideArchive(realpathSync(options.root), options.inputReceiptPath);
  const source = JSON.parse(String(pinnedReceiptBytes(options.sourceReceiptPath, options.sourceReceiptSha256)));
  assert.equal(source.sourceCommit, selectedCommit, 'Operator-api independent selected commit differs');
  verifyArchivedSourceSync(options.root, source, { runtimeArtifacts: true });
  const bytes = pinnedReceiptBytes(options.inputReceiptPath, options.inputReceiptSha256);
  const inputs = JSON.parse(String(bytes));
  assertOperatorApiPlannedInputs(options.root, source, inputs);
  return { source, inputs, bytes };
}

/** Transport the independently verified archive receipt into native reporters.
 * A successful parent preflight alone does not give a child source provenance.
 * @param {{ root: string, receiptPath: string, env?: NodeJS.ProcessEnv }} options
 */
export function verifierSourceChildEnv({ root, receiptPath, env = process.env }) {
  const sourceRoot = realpathSync(root);
  const receipt = realpathSync(receiptPath);
  const receiptRel = relative(sourceRoot, receipt);
  if (receiptRel !== '..' && !receiptRel.startsWith(`..${sep}`)) {
    throw new PreviewError('verifier source receipt must be outside the archive', 2);
  }
  const expected = JSON.parse(readFileSync(receipt, 'utf8'));
  verifyVerifierSourceSync(sourceRoot, expected, { runtimeArtifacts: true });
  return { ...env, VERIFY_TAURI_SOURCE_RECEIPT: receipt, VERIFY_TAURI_SOURCE_REF: expected.sourceCommit };
}

const VERIFIER_PREPARATION_PHASES = ['source.freeze', 'receipt.write', 'deps.source.before',
  'deps.snapshot', 'deps.source.after-snapshot', 'deps.inputs', 'deps.measure',
  'deps.source.after-preflight', 'deps.census', 'deps.receipt.write'];

/** Read observations only, never acceptance evidence. A killed phase is not a duration.
 * @param {string} path @returns {Record<string, number>}
 */
export function readVerifierPhaseMeasurements(path) {
  const rows = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const measurements = {};
  const started = new Set();
  let sequence = 0, elapsed = 0;
  for (const row of rows) {
    assert.ok(row.schemaVersion === 'verifier-phase-v1' && row.sequence === ++sequence &&
      Number.isSafeInteger(row.elapsedMs) && row.elapsedMs >= elapsed && typeof row.phase === 'string',
    'Invalid verifier phase budget receipt');
    elapsed = row.elapsedMs;
    if (row.event === 'started') {
      assert.ok(!started.has(row.phase), 'Duplicate verifier phase start');
      started.add(row.phase);
    } else {
      assert.ok(started.delete(row.phase) && ['completed', 'failed'].includes(row.event),
        'Verifier phase terminal record lacks a start');
      if (row.event === 'completed') {
        assert.ok(Number.isSafeInteger(row.durationMs) && row.durationMs >= 0,
          'Invalid verifier phase duration');
        measurements[row.phase] = row.durationMs;
      }
    }
  }
  return measurements;
}

/** Reserve both complete final censuses and cleanup, using this run's observations or an
 * explicitly selected earlier phase receipt. Estimates are prognoses, not guarantees;
 * an omitted child estimate remains explicitly unknown. No source/dependency scope changes.
 * @param {Record<string, number>} measurements @param {number} [childEstimateMs]
 */
export function estimateVerifierCommandBudget(measurements, childEstimateMs = 0) {
  for (const phase of VERIFIER_PREPARATION_PHASES)
    assert.ok(Number.isSafeInteger(measurements[phase]) && measurements[phase] >= 0,
      `Verifier budget requires completed phase: ${phase}`);
  assert.ok(Number.isSafeInteger(childEstimateMs) && childEstimateMs >= 0, 'Invalid verifier child estimate');
  const preparationMs = VERIFIER_PREPARATION_PHASES.reduce((total, phase) => total + measurements[phase], 0);
  const sourceCheckMs = Math.max(...['deps.source.before', 'deps.source.after-snapshot',
    'deps.source.after-preflight', 'child.preflight', 'source.postverify'].map(phase => measurements[phase] ?? 0));
  const dependencyCheckMs = Math.max(measurements['deps.census'], measurements['deps.postverify'] ?? 0);
  // With no completed cleanup receipt, reserve at least the observed snapshot/freezing
  // work: deletion must still walk the whole population. This is a conservative proxy.
  const cleanupMs = Math.max(measurements.cleanup ?? 0, measurements['source.freeze'], measurements['deps.snapshot']);
  const remainingMs = sourceCheckMs * 2 + dependencyCheckMs + cleanupMs + childEstimateMs;
  return { preparationMs, sourceCheckMs, dependencyCheckMs, cleanupMs, childEstimateMs,
    unknownChild: childEstimateMs === 0, remainingMs: Math.ceil(remainingMs * 1.25),
    totalMs: Math.ceil((preparationMs + remainingMs) * 1.25) };
}

/** Reuse the launcher's absolute deadline and the scheduler's attributable refusal. */
export function admitVerifierCommandBudget(estimate, { env = process.env, nowMs = Date.now(), preparation = false } = {}) {
  const deadlineEpochMs = readTaskDeadlineEpochMs(env);
  const knownEstimateMs = estimate ? (preparation ? estimate.totalMs : estimate.remainingMs) : 0;
  const remainingMs = deadlineEpochMs === null ? null : deadlineEpochMs - nowMs;
  if (remainingMs !== null && (remainingMs <= 0 || remainingMs <= knownEstimateMs))
    throw new PreviewError(formatTaskDeadlineRefusal({ remainingMs, knownEstimateMs,
      knownTasks: estimate ? VERIFIER_PREPARATION_PHASES.length : 0, unknownTasks: estimate?.unknownChild === false ? 0 : 1 }), 2);
  return { deadlineEpochMs, remainingMs, knownEstimateMs, estimate };
}

async function listFiles(dir) {
  const out = [];
  async function walk(d) {
    for (const ent of await fs.readdir(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) await walk(p);
      else out.push(relative(dir, p).split(sep).join('/'));
    }
  }
  await walk(dir);
  return out.sort();
}

export function noticeText(manifest) {
  if (manifest.target === 'public') {
    return [
      'Papercusp',
      '',
      `Copyright (c) ${manifest.year} Papercusp.`,
      '',
      'Licensed under the Elastic License 2.0 (see LICENSE). Libraries that carry their own',
      'license file or SPDX header (for example the permissively licensed libs/generic/*)',
      'are covered by that license instead.',
      '',
      'Third-party components keep their own licenses.',
      '',
      `Exported from ${manifest.source.repo} @ ${manifest.source.commit}`,
      '',
    ].join('\n');
  }
  return [
    'Papercusp — private source preview',
    '',
    `Copyright (c) ${manifest.year} Papercusp. All rights reserved.`,
    '',
    'This source is shared privately, by invitation, for EVALUATION ONLY.',
    '',
    'You may read it and run it on your own machines to evaluate Papercusp.',
    'You may not redistribute, publish, sublicense or sell it, in whole or in part,',
    'or use it to build or train a competing product or model.',
    '',
    'No license is granted beyond this evaluation permission. Access can be',
    'revoked at any time, and this notice applies to every copy you keep.',
    '',
    `Snapshot: ${manifest.source.repo} @ ${manifest.source.commit}`,
    '',
  ].join('\n');
}

async function describeWorkspaces(dir) {
  const rows = [];
  for (const top of ['apps', 'libs', 'packages']) {
    const base = join(dir, top);
    if (!existsSync(base)) continue;
    const walk = async (rel, depth) => {
      const abs = join(dir, rel);
      const pkg = join(abs, 'package.json');
      if (existsSync(pkg)) {
        let name = rel;
        let description = '';
        try {
          const j = JSON.parse(await fs.readFile(pkg, 'utf8'));
          name = j.name || rel;
          description = typeof j.description === 'string' ? j.description : '';
        } catch { /* unparsable package.json: list the path only */ }
        rows.push({ rel, name, description });
        return;
      }
      if (depth === 0) return;
      for (const ent of await fs.readdir(abs, { withFileTypes: true })) {
        if (ent.isDirectory()) await walk(`${rel}/${ent.name}`, depth - 1);
      }
    };
    for (const ent of (await fs.readdir(base, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.isDirectory()) await walk(`${top}/${ent.name}`, 1);
    }
  }
  return rows;
}

/**
 * The releases page README.md links to: `${PAPERCUSP_UPDATE_BASE_URL}/index.html`.
 * Reads `env` only — never a file — so a test's verdict cannot depend on the home
 * directory it runs in; the CLI fills `env` first (loadReleaseHost).
 * @param {NodeJS.ProcessEnv} env
 */
export function releasesPageUrl(env) {
  const base = (env[RELEASE_BASE_ENV] ?? '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/\S+$/.test(base)) {
    throw new PreviewError(`${RELEASE_BASE_ENV} is ${base ? `not an https URL (${base})` : 'unset'} — README.md must link the releases page; export it or provide ${RELEASE_HOST_ENV_PATH}`, 2);
  }
  return `${base}/index.html`;
}

/**
 * Fill PAPERCUSP_UPDATE_BASE_URL from the release scripts' own config file when the
 * environment is silent. An exported value always wins, as in release-host.sh.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [path]
 */
export function loadReleaseHost(env = process.env, path = RELEASE_HOST_ENV_PATH) {
  if (env[RELEASE_BASE_ENV] || !existsSync(path)) return;
  const value = parseEnv(readFileSync(path, 'utf8'))[RELEASE_BASE_ENV];
  if (value) env[RELEASE_BASE_ENV] = value;
}

export async function readmeText(dir, manifest, releasesUrl) {
  const tops = (await fs.readdir(dir, { withFileTypes: true }))
    .filter((e) => !PUBLIC_ADDED_TOPS.has(e.name))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();
  const ws = await describeWorkspaces(dir);
  const isPublic = manifest.target === 'public';
  const intro = isPublic
    ? [
      '# Papercusp',
      '',
      'Papercusp is a desktop workspace where coding agents work alongside you, coordinated',
      'through shared plans, work items, locks and memory. Papercusp is source-available',
      'under the Elastic License 2.0 (see LICENSE and NOTICE): you may read, run,',
      'modify and self-host it, but not offer it to others as a hosted or managed service.',
      '',
      `- Exported from \`${manifest.source.repo}\` at \`${manifest.source.commit}\`, with`,
      `  ${manifest.submodules.length} submodule(s) flattened in at their pinned commits (MANIFEST.json).`,
      '- It is the same public-safe source cut the Papercusp Server installer carries, without',
      '  `node_modules` (run `npm ci` to install dependencies from `package-lock.json`), plus the',
      '  Tauri desktop shell in `papercusp-desktop/`.',
      '- Each update is a new commit on top of the previous one, so `git pull` works and forks',
      '  and pull requests keep a shared history.',
      '',
    ]
    : [
      '# Papercusp — source preview',
      '',
      'Papercusp is a desktop workspace where coding agents work alongside you, coordinated',
      'through shared plans, work items, locks and memory. This repository is a private,',
      'read-only snapshot of its source, shared for evaluation (see NOTICE).',
      '',
      `- Snapshot of \`${manifest.source.repo}\` at \`${manifest.source.commit}\`, with`,
      `  ${manifest.submodules.length} submodule(s) flattened in at their pinned commits (MANIFEST.json).`,
      '- It is the same public-safe source cut the Papercusp Server installer carries, without',
      '  `node_modules` (run `npm ci` to install dependencies from `package-lock.json`)',
      '  and without the Tauri desktop shell or git history.',
      '- It is replaced wholesale on each update: re-clone or `git fetch && git reset --hard origin/main`.',
      '',
    ];
  const lines = [
    ...intro,
    '## Download Papercusp',
    '',
    `Installers for every published version, with release notes and install instructions, are on`,
    `the **[Papercusp releases page](${releasesUrl})**. Install both apps: **Papercusp Server**`,
    'runs the operator, its embedded database and your agents on your machine, and **Papercusp GUI**',
    'is the desktop window onto it.',
    '',
    ...(isPublic
      ? [
        '## Build and run from source',
        '',
        'You need **Node.js 25** (see `.nvmrc`), **Rust stable** (1.77 or newer) and your platform\'s',
        'webview build libraries (the table under "Prerequisites" in `papercusp-desktop/README.md`).',
        'You also need **pgvector for PostgreSQL 18**: the app runs its own embedded Postgres, and the',
        'schema uses the `vector` extension, which that Postgres does not ship with. On Debian or',
        'Ubuntu, install `postgresql-18-pgvector` from the PostgreSQL apt repository',
        '(https://wiki.postgresql.org/wiki/Apt); on macOS, `brew install pgvector`.',
        '',
        '```sh',
        'npm ci                                               # also copies pgvector into the embedded Postgres',
        'npm --workspace @papercusp/operator-vite run build   # the UI bundle the desktop window loads',
        'cd papercusp-desktop && npm ci && npm run dev        # builds the Rust shell and opens the window',
        '```',
        '',
        'The first `npm run dev` compiles the Rust shell, which takes several minutes. The app then',
        'creates its embedded database, applies the migrations and serves the operator from this',
        'tree. If pgvector was missing during `npm ci`, install it and run',
        '`node scripts/install-embedded-pgvector.mjs`. Release installers are built by',
        '`papercusp-desktop/bin/build-linux-local.sh` and its siblings, which also need signing and',
        'release-identity inputs that development does not.',
        '',
      ]
      : []),
    '## How this source ships inside every release',
    '',
    'The Papercusp Server installer carries this same source tree as one compressed resource,',
    '`sidecar/source.tar.zst`:',
    '',
    '- **What is in it.** The code you are reading plus its already-installed `node_modules`. The',
    '  release build selects it with the same allowlist, and checks it with the same audit, that',
    '  produced this snapshot. Both refuse git history, internal plans, agent transcripts and',
    '  state, and credentials, and both redact personal identity. The only difference here is that',
    '  `node_modules` is left out.',
    '- **Where it goes.** On first launch the app extracts the archive into a writable folder in',
    '  its own data directory (on Windows, inside the `papercup-runtime` WSL distro). Later',
    '  launches skip the extract.',
    '- **What runs from it.** Two of the environments in the app\'s environment switcher run',
    '  Papercusp from that extracted source instead of from the prebuilt server: **dev**',
    '  (port 3270) runs the API host straight from TypeScript (`tsx apps/operator/bin/hono-host.ts`),',
    '  and **local** (port 3055) runs the Vite dev server over the UI in `apps/operator-vite`.',
    '  Both run on the Node.js bundled in the app with the tree\'s own `tsx` and `vite`, because',
    '  an installed machine has no npm.',
    '',
    '## Why the release carries its own source',
    '',
    'So that the Papercusp you installed can run a Papercusp you changed. Papercusp is developed',
    'with Papercusp, and shipping the runnable source means any install can do what the',
    'development machine does: open the tree, edit it (by hand or with agents), and run the edited',
    'build side by side with the installed one, without cloning a repository or installing a',
    'toolchain. Two design choices follow from that:',
    '',
    '- **Extracted to a writable folder, not run in place.** The install directory is read-only,',
    '  and a source tree you cannot edit defeats the purpose.',
    '- **One archive, not loose files.** The tree with its `node_modules` runs to several',
    '  gigabytes of small files. Copying them one by one through the app bundler\'s resource',
    '  pipeline is slow, and the `node_modules/.bin` symlinks survive `tar` but not that copy.',
    '',
    'This repository is the same source without `node_modules`, so you can read it before you install.',
    '',
    ...(isPublic
      ? [
        '## Contributing, security and telemetry',
        '',
        '- **Contributing:** see CONTRIBUTING.md. Code contributions need a signed Contributor',
        '  License Agreement; a bot links it on your first pull request.',
        '- **Security:** report vulnerabilities privately, as described in SECURITY.md.',
        '- **Conduct:** everyone taking part follows CODE_OF_CONDUCT.md.',
        '- **Telemetry is off unless you opt in** during setup, and development builds never send',
        '  any. If you distribute your own build, point opted-in telemetry at your own PostHog',
        '  with `PAPERCUSP_POSTHOG_HOST` and `PAPERCUSP_POSTHOG_KEY` (or `~/.papercusp/posthog.json`);',
        '  otherwise it goes to Papercusp\'s. The in-app support chat loads only on the `/support` page.',
        '',
      ]
      : []),
    '## Where to read first',
    '',
    '- `CLAUDE.md` / `AGENTS.md` — the conventions every agent in this codebase works under.',
    '- `docs/` — design and architecture notes.',
    '- `apps/operator/` — the operator: API host, agent tools, coordination.',
    '- `libs/papercusp/` — the core platform libraries (database schema and migrations live in `libs/papercusp/libs/db/`).',
    '',
    '## Top-level layout',
    '',
    ...tops.map((t) => `- \`${t}\``),
    '',
    '## Workspaces',
    '',
    '| path | package | description |',
    '|---|---|---|',
    ...ws.map((w) => `| \`${w.rel}\` | \`${w.name}\` | ${w.description.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()} |`),
    '',
  ];
  return lines.join('\n');
}

/**
 * The copyright year of `commit`: the newest commit date in its recent first-parent history.
 * The commit's own date is unusable — repair-queue admission commits carry a fixed 2000-01-01.
 * @param {string} repo
 * @param {string} commit
 */
export function sourceYear(repo, commit) {
  const stamps = git(repo, ['log', '-n', '200', '--first-parent', '--format=%ct', commit]).trim().split('\n').map(Number);
  return new Date(Math.max(...stamps) * 1000).getUTCFullYear();
}

/**
 * Export one pinned commit as the public-safe cut into `out` (must not exist).
 * Deterministic for a given commit — no timestamps — so a drift check compares
 * content, not clock.
 * `thirdPartyNotices(dir)` renders THIRD-PARTY-NOTICES.md for the public target; tests
 * inject a stub so they need no cargo resolve.
 * @param {{ repoRoot?: string, ref?: string, out: string, target?: string, licensePath?: string, selectScript?: string, selectionLib?: string, env?: NodeJS.ProcessEnv, log?: Log, thirdPartyNotices?: (dir: string) => { text: string, undetermined: string[] } }} opts
 */
export async function exportSnapshot({
  repoRoot = ROOT,
  ref = DEFAULT_REF,
  out,
  target: targetName = 'preview',
  licensePath = PUBLIC_LICENSE_PATH,
  selectScript = SELECT_SCRIPT,
  selectionLib = SELECTION_LIB,
  env = process.env,
  log = () => {},
  thirdPartyNotices = (dir) => collectThirdPartyNotices(dir),
}) {
  if (!out) throw new PreviewError('exportSnapshot: out is required', 2);
  if (existsSync(out)) throw new PreviewError(`refusing to overwrite existing ${out}`, 2);
  const target = resolveTarget(targetName);
  const license = target.key === 'public' ? readLicense(licensePath) : null;
  const community = target.key === 'public' ? readCommunityFiles(dirname(licensePath)) : [];
  const releasesUrl = releasesPageUrl(env);
  const commit = resolveCommit(repoRoot, ref);
  const allow = allowlistTops(selectionLib);
  // The public repository also carries the Tauri desktop shell (P-004), which the shared
  // selection leaves out because the installer never ships it. Materialize it too (a
  // gitlink resolves at its pinned commit) and add it after the selection.
  if (target.key === 'public') allow.add(DESKTOP_DIR);
  const work = await mkdtemp(join(tmpdir(), 'source-preview-'));
  const partial = `${out}.partial-${process.pid}`;
  try {
    const mono = join(work, 'mono');
    await fs.mkdir(mono);
    log(`materializing ${commit} (+ submodules at their gitlinks)`);
    const submodules = materializeCommit({ repo: repoRoot, sha: commit, dest: mono, allow });
    await fs.mkdir(dirname(partial), { recursive: true });
    log('selecting the public-safe cut (shared with the installer)');
    const sel = spawnSync('bash', [selectScript, '--mono', mono, '--into', partial, '--mode', 'preview'], {
      encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024,
    });
    if (sel.status !== 0) {
      throw new PreviewError(`source-tree-select refused (exit ${sel.status}): ${(sel.stderr || sel.stdout).trim().slice(-2000)}`, sel.status === 2 ? 2 : 1);
    }
    if (target.key === 'public') log(`desktop shell: identity scrub redacted ${copyDesktopShell(mono, partial, { env })} file(s)`);
    const files = await listFiles(partial);
    const vcs = files.filter((f) => f === '.git' || f.startsWith('.git/') || f.includes('/.git/') || f.endsWith('/.git'));
    if (vcs.length) throw new PreviewError(`export contains git metadata: ${vcs.slice(0, 5).join(', ')}`);
    const collisions = files.filter((f) => PUBLIC_ADDED_FILES.includes(f));
    if (collisions.length) throw new PreviewError(`the selection already ships ${collisions.join(', ')} — refusing to overwrite`);
    const shipped = submodules.filter((s) => existsSync(join(partial, s.path)));
    const manifest = {
      schema: 1,
      target: target.key,
      purpose: target.purpose,
      year: sourceYear(repoRoot, commit),
      source: { repo: SOURCE_REPO, ref, commit },
      submodules: shipped,
      notShipped: submodules.filter((s) => !shipped.includes(s)).map((s) => s.path),
      fileCount: files.length,
      generatedBy: 'scripts/source-preview.mjs',
    };
    if (license !== null) await fs.writeFile(join(partial, 'LICENSE'), license);
    for (const { name, text } of community) {
      await fs.mkdir(dirname(join(partial, name)), { recursive: true });
      await fs.writeFile(join(partial, name), text);
    }
    if (target.key === 'public') {
      // Generated from the EXPORTED lockfiles, so it lists exactly what ships. A partial
      // measurement must not publish as a complete notices file.
      const notices = thirdPartyNotices(partial);
      if (notices.undetermined.length) {
        throw new Error(`${NOTICES_FILE}: part of the dependency graph was not measured — ${notices.undetermined.join('; ')}`);
      }
      await fs.writeFile(join(partial, NOTICES_FILE), notices.text);
    }
    await fs.writeFile(join(partial, 'NOTICE'), noticeText(manifest));
    await fs.writeFile(join(partial, 'README.md'), await readmeText(partial, manifest, releasesUrl));
    await fs.writeFile(join(partial, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.rename(partial, out);
    return { out, manifest };
  } catch (err) {
    await rm(partial, { recursive: true, force: true });
    throw err;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * The public target's LICENSE text. Refuses when missing or when it is not the Elastic
 * License 2.0: publishing source under no license, or the wrong one, is not recoverable
 * once cloned.
 * @param {string} path
 */
export function readLicense(path) {
  if (!existsSync(path)) throw new PreviewError(`public target needs its LICENSE at ${path}`, 2);
  const text = readFileSync(path, 'utf8');
  if (!/^Elastic License 2\.0/m.test(text)) throw new PreviewError(`${path} is not the Elastic License 2.0 text`, 2);
  return text;
}

/**
 * Copy the desktop shell from the materialized tree into the public export, minus
 * generated and internal paths. Refuses when the commit has no desktop shell: a public
 * source release without its shell is not the product (P-004). Everything copied is
 * still checked by the same bundle audit as the rest of the export.
 * @param {string} mono the materialized commit
 * @param {string} into the export being assembled
 */
export function copyDesktopShell(mono, into, { env = process.env, auditScript = AUDIT_SCRIPT } = {}) {
  const from = join(mono, DESKTOP_DIR);
  if (!existsSync(from) || readdirSync(from).length === 0) {
    throw new PreviewError(`public target needs the desktop shell at ${DESKTOP_DIR}/ in the source commit`, 2);
  }
  const dest = join(into, DESKTOP_DIR);
  run('mkdir', ['-p', dest]);
  // The gate's own forbidden-path globs (test files, secrets, VCS, …), exactly as the
  // shared selection derives them (source-tree-selection.sh step 1). Without them the
  // shell's test/ tree shipped and the bundle audit refused the cut (P-020 re-export).
  const gateExcludes = gateTarExcludes({ env, auditScript });
  const excludes = [...DESKTOP_PUBLIC_EXCLUDES, ...gateExcludes].map((p) => `--exclude=${p}`);
  run('bash', ['-c', 'set -euo pipefail; src="$1"; dst="$2"; shift 2; tar -C "$src" -cf - "$@" . | tar -C "$dst" -xf -', '_', from, dest, ...excludes]);
  // Rooted at the shell itself: --source-leakers skips `papercusp-desktop/*` paths (the
  // installer's self-reference), so scanning from `into` would silently find nothing.
  return scrubIdentity(dest, readdirSync(dest), { env, auditScript });
}

/**
 * The bundle audit's forbidden-path tar globs (`--tar-excludes`). Refuses on failure or
 * an empty list: copying an unfiltered tree is the failure this exists to prevent (WI-4419).
 * @param {{ env?: NodeJS.ProcessEnv, auditScript?: string }} [opts]
 * @returns {string[]}
 */
export function gateTarExcludes({ env = process.env, auditScript = AUDIT_SCRIPT } = {}) {
  const r = spawnSync('python3', [auditScript, '--tar-excludes'], { encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new PreviewError(`audit --tar-excludes failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().slice(-1000)}`, 2);
  const globs = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!globs.length) throw new PreviewError('audit --tar-excludes returned nothing — refusing to copy an unfiltered desktop shell', 2);
  return globs;
}

/**
 * The SAME audit-owned identity scrub source-tree-select.sh applies to the shared
 * selection (--source-leakers finds the files, --scrub-text redacts each on the COPY).
 * Anything added to the export after the selection must pass through it too: the desktop
 * shell's own dev scripts and tests name the maintainers, and a bare copy shipped them
 * verbatim until the gate refused (open-source-release P-004/P-013).
 * @param {string} dir the export being assembled
 * @param {string[]} entries top-level entries of `dir` to scan
 * @param {{ env?: NodeJS.ProcessEnv, auditScript?: string }} [opts]
 * @returns {number} how many files were redacted
 */
export function scrubIdentity(dir, entries, { env = process.env, auditScript = AUDIT_SCRIPT } = {}) {
  const leak = spawnSync('python3', [auditScript, '--source-leakers', dir, ...entries], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  if (leak.status !== 0) throw new PreviewError(`identity scrub: --source-leakers failed (exit ${leak.status}): ${(leak.stderr || leak.stdout).trim().slice(-1000)}`, 2);
  const files = leak.stdout.split('\n').map((l) => l.trim()).filter((rel) => rel && existsSync(join(dir, rel)));
  for (const rel of files) {
    const s = spawnSync('python3', [auditScript, '--scrub-text', join(dir, rel)], { encoding: 'utf8', env });
    if (s.status !== 0) throw new PreviewError(`identity scrub: --scrub-text ${rel} failed (exit ${s.status}): ${(s.stderr || s.stdout).trim().slice(-500)}`, 2);
  }
  return files.length;
}

/**
 * The public target's community files, read from `dir` (scripts/public-release/ by
 * default — beside the LICENSE). Refuses when any is missing or empty.
 * @param {string} dir
 * @returns {{ name: string, text: string }[]}
 */
export function readCommunityFiles(dir) {
  return PUBLIC_COMMUNITY_FILES.map((name) => {
    const path = join(dir, name);
    if (!existsSync(path)) throw new PreviewError(`public target needs ${name} at ${path}`, 2);
    const text = readFileSync(path, 'utf8');
    if (!text.trim()) throw new PreviewError(`${path} is empty`, 2);
    return { name, text };
  });
}

function which(bin, env) {
  const r = spawnSync('bash', ['-c', 'command -v "$1"', '_', bin], { encoding: 'utf8', env });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * The fail-closed gate. Every detector must RUN and come back clean; a finding
 * refuses (exit 1) and a detector that cannot run refuses too (exit 2).
 * @param {string} dir
 * @param {{ env?: NodeJS.ProcessEnv, auditScript?: string, allowlistPath?: string }} [opts]
 * @returns {Promise<GateVerdict>}
 */
export async function runGate(dir, { env = process.env, auditScript = AUDIT_SCRIPT, allowlistPath = ALLOWLIST_PATH } = {}) {
  const results = [];
  const allFindings = [];
  const allowlist = await loadAllowlist(allowlistPath);
  const record = (name, status, detail) => results.push({ name, ok: status === 'clean', status, detail: detail.trim().slice(-3000) });
  if (!existsSync(dir)) throw new PreviewError(`gate: ${dir} does not exist`, 2);
  const tools = { python3: which('python3', env), tar: which('tar', env), zstd: which('zstd', env), gitleaks: which('gitleaks', env), trufflehog: which('trufflehog', env) };
  const missing = Object.entries(tools).filter(([, p]) => !p).map(([n]) => n);
  if (missing.length) {
    for (const m of missing) record(m, 'cannot-check', `${m} not found on PATH — the gate refuses rather than skip a detector`);
    return { ok: false, exitCode: 2, results };
  }
  const work = await mkdtemp(join(tmpdir(), 'source-preview-gate-'));
  try {
    // 1. The installer's own audit over a packed copy: forbidden paths, identity, credentials.
    const bundle = join(work, 'preview.tar.zst');
    run('bash', ['-c', 'set -euo pipefail; tar --sort=name --numeric-owner --owner=0 --group=0 -C "$1" -cf - . | zstd -q -3 -f -o "$2"', '_', dir, bundle], { env });
    const a = spawnSync(tools.python3, [auditScript, bundle], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
    record('audit-release-bundle', a.status === 0 ? 'clean' : a.status === 1 ? 'finding' : 'cannot-check', `${a.stdout}\n${a.stderr}`);
    // 2. Its directory backstop (honors no path-exclude).
    const s = spawnSync(tools.python3, [auditScript, '--scan-dir', dir], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
    record('audit-release-bundle --scan-dir', s.status === 0 ? 'clean' : s.status === 1 ? 'finding' : 'cannot-check', `${s.stdout}\n${s.stderr}`);
    // 3. gitleaks, default rules. The report holds raw secrets, so it stays in the
    //    temp dir (removed below) and only SHA-256 fingerprints leave this function.
    const report = join(work, 'gitleaks.json');
    const g = spawnSync(tools.gitleaks, ['dir', dir, '--no-banner', '--exit-code', '1', '--report-format', 'json', '--report-path', report], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
    if (g.status === 0 || g.status === 1) {
      let raw = [];
      if (g.status === 1) {
        try { raw = JSON.parse(await fs.readFile(report, 'utf8')); } catch (e) { record('gitleaks', 'cannot-check', `unreadable report: ${e.message}`); raw = null; }
      }
      if (raw) {
        const found = raw.map((f) => fingerprint('gitleaks', f.RuleID, relPath(dir, f.File), f.StartLine, f.Secret ?? f.Match ?? ''));
        if (g.status === 1 && found.length === 0) record('gitleaks', 'cannot-check', 'gitleaks exited 1 but its report lists no findings');
        else recordFindings('gitleaks', found);
      }
    } else {
      record('gitleaks', 'cannot-check', `${g.stdout}\n${g.stderr}`);
    }
    // 4. trufflehog, detection only: --no-verification, because verifying would send
    //    each candidate secret to its provider's API.
    const t = spawnSync(tools.trufflehog, ['filesystem', dir, '--no-update', '--no-verification', '--json', '--fail'], { encoding: 'utf8', env, maxBuffer: 256 * 1024 * 1024 });
    if (t.status === 0 || t.status === 183) {
      const found = [];
      let unparsable = 0;
      for (const l of t.stdout.split('\n').filter(Boolean)) {
        try {
          const j = JSON.parse(l);
          const fsMeta = j.SourceMetadata?.Data?.Filesystem ?? {};
          found.push(fingerprint('trufflehog', j.DetectorName, relPath(dir, fsMeta.file ?? '?'), fsMeta.line ?? 0, j.Raw ?? j.RawV2 ?? ''));
        } catch { unparsable += 1; }
      }
      if (unparsable || (t.status === 183 && found.length === 0)) record('trufflehog', 'cannot-check', `${unparsable} unparsable output line(s); exit ${t.status}`);
      else recordFindings('trufflehog', found);
    } else {
      record('trufflehog', 'cannot-check', `exit ${t.status}: ${t.stderr}`);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  const ok = results.every((r) => r.ok);
  const exitCode = ok ? 0 : results.some((r) => r.status === 'finding') ? 1 : 2;
  return { ok, exitCode, results, findings: allFindings };

  function recordFindings(name, found) {
    const open = found.filter((f) => !isAllowlisted(allowlist, f));
    allFindings.push(...found.map((f) => ({ ...f, allowlisted: !open.includes(f) })));
    const accepted = found.length - open.length;
    const detail = open.slice(0, 60).map((f) => `${f.rule}  ${f.path}:${f.line}  sha256:${f.sha256.slice(0, 12)}`).join('\n')
      + (open.length > 60 ? `\n… ${open.length - 60} more` : '')
      + (accepted ? `\n(${accepted} reviewed false positive(s) accepted by ${relative(ROOT, allowlistPath)})` : '');
    record(name, open.length ? 'finding' : 'clean', detail);
  }
}

/** True when `p` is `root` itself or lies beneath it. @param {string} root @param {string} p */
function isInside(root, p) {
  const rel = relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Mirror one node_modules directory of the INTERNAL tree into the same relative place in a
 * copy of the cut, the way `npm ci` in public CI would leave it. A workspace link (its target
 * lies outside the node_modules directory) is re-pointed to the same repository-relative path
 * INSIDE the copy, so it resolves to the CUT's package — never to the internal tree's, which
 * holds files the cut drops and peers' uncommitted edits. Every installed package is linked
 * to the internal tree's copy. Scope directories (`@scope/`) are mirrored one level down.
 * @param {{ modulesRoot: string, copy: string, src: string, nmRoot?: string }} a
 */
async function mirrorNodeModules({ modulesRoot, copy, src, nmRoot = src }) {
  const dst = join(copy, relative(modulesRoot, src));
  await fs.mkdir(dst, { recursive: true });
  for (const ent of await fs.readdir(src, { withFileTypes: true })) {
    const from = join(src, ent.name);
    const to = join(dst, ent.name);
    if (ent.name.startsWith('@') && ent.isDirectory()) {
      await mirrorNodeModules({ modulesRoot, copy, src: from, nmRoot });
      continue;
    }
    if (ent.isSymbolicLink()) {
      const target = resolve(dirname(from), await fs.readlink(from));
      if (!isInside(nmRoot, target)) {
        // A workspace link. Inside the repository it maps into the copy (dangling when the
        // cut drops that workspace, exactly as npm ci would have no such package).
        await fs.symlink(isInside(modulesRoot, target) ? join(copy, relative(modulesRoot, target)) : target, to);
        continue;
      }
    }
    await fs.symlink(from, to);
  }
}

/**
 * Every node_modules directory of the internal tree whose parent directory exists in the
 * copy, up to `maxDepth` levels below the root. Directories the cut does not contain are
 * not descended into.
 * @param {string} modulesRoot @param {string} copy @param {number} [maxDepth]
 * @returns {Promise<string[]>}
 */
async function nodeModulesFor(modulesRoot, copy, maxDepth = 6) {
  const found = [];
  const walk = async (dir, depth) => {
    let ents;
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      if (!ent.isDirectory() || ent.name === '.git' || ent.name === '.papercusp') continue;
      const p = join(dir, ent.name);
      if (ent.name === 'node_modules') { found.push(p); continue; }
      if (depth < maxDepth && existsSync(join(copy, relative(modulesRoot, p)))) await walk(p, depth + 1);
    }
  };
  await walk(modulesRoot, 1);
  return found;
}

/**
 * The public cut's own typecheck — WI-10006584. Public CI on Papercusp/papercusp-app runs
 * `npm ci` then `npm run lint:tsc` on every pushed commit, and the cut can fail it while the
 * internal tree passes: the cut drops files (tests, closed-layer packages) whose ambient type
 * augmentations other files relied on (5eb41d7e went red that way). Nothing before the push
 * saw it, and an append-only push cannot be taken back. This leg runs the CUT's own lint
 * script over a COPY of the export (the export itself is what gets committed, so nothing may
 * be added to it), with the internal tree's installed dependencies standing in for `npm ci`.
 * Fail-closed like the gate: a type regression is a finding (exit 1); a run that cannot
 * complete or reports no verdict is cannot-check (exit 2).
 * @param {string} dir
 * @param {{ env?: NodeJS.ProcessEnv, modulesRoot?: string, script?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<GateResult>}
 */
export async function runCutTypecheck(dir, { env = process.env, modulesRoot = ROOT, script = 'lint:tsc', timeoutMs = 45 * 60 * 1000 } = {}) {
  const name = `cut typecheck (npm run ${script})`;
  const result = (status, detail) => ({ name, ok: status === 'clean', status, detail: detail.trim().slice(-3000) });
  if (!existsSync(dir)) throw new PreviewError(`typecheck: ${dir} does not exist`, 2);
  let scripts = {};
  try { scripts = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts ?? {}; } catch (e) {
    return result('cannot-check', `the cut has no readable package.json: ${e.message}`);
  }
  if (!scripts[script]) return result('cannot-check', `the cut's package.json has no "${script}" script — public CI would have nothing to run either`);
  const copy = await mkdtemp(join(tmpdir(), 'source-preview-typecheck-'));
  try {
    run('cp', ['-a', `${dir}/.`, copy], { env });
    for (const nm of await nodeModulesFor(modulesRoot, copy)) await mirrorNodeModules({ modulesRoot, copy, src: nm });
    const r = spawnSync('npm', ['run', '--silent', script], { cwd: copy, encoding: 'utf8', env: { ...env, CI: 'true' }, maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs });
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    if (r.error || r.signal) return result('cannot-check', `npm run ${script} did not complete (${r.error?.message ?? `signal ${r.signal}`})\n${out}`);
    const marker = [...out.matchAll(/LINT_TSC_RESULT\b[^\n]*\bstatus=(\S+)/g)].at(-1);
    if (!marker) return result('cannot-check', `npm run ${script} exited ${r.status} without a LINT_TSC_RESULT verdict line\n${out}`);
    if (r.status === 0) return result('clean', marker[0]);
    if (r.status === 1 && marker[1] === 'regressed') return result('finding', out);
    return result('cannot-check', `npm run ${script} exited ${r.status} (status=${marker[1]})\n${out}`);
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
}

/**
 * The public target's gate: the detector gate, then the cut typecheck. The typecheck takes
 * minutes, so it runs only when the detectors are clean (a refusal is a refusal either way).
 * @param {string} dir
 * @param {{ env?: NodeJS.ProcessEnv, gate?: Gate, typecheck?: (dir: string, opts: { env?: NodeJS.ProcessEnv }) => Promise<GateResult> }} [opts]
 * @returns {Promise<GateVerdict>}
 */
export async function runPublicGate(dir, { env = process.env, gate = runGate, typecheck = runCutTypecheck } = {}) {
  const verdict = await gate(dir, { env });
  if (!verdict.ok) return verdict;
  const tc = await typecheck(dir, { env });
  const results = [...verdict.results, tc];
  const ok = results.every((r) => r.ok);
  const exitCode = ok ? 0 : results.some((r) => r.status === 'finding') ? 1 : 2;
  return { ...verdict, ok, exitCode, results };
}

/** The gate a target's push uses unless the caller injects one. @param {Target} target @returns {Gate} */
export function defaultGateFor(target) {
  return target.key === 'public' ? runPublicGate : runGate;
}

function relPath(dir, file) {
  const rel = relative(dir, file);
  return (rel.startsWith('..') ? file : rel).split(sep).join('/');
}

/** A finding without its secret: rule, path, line, and the SHA-256 of the matched value. */
function fingerprint(detector, rule, path, line, secret) {
  return { detector, rule: String(rule), path, line: Number(line) || 0, sha256: createHash('sha256').update(String(secret)).digest('hex') };
}

export const ALLOWLIST_PATH = join(ROOT, 'scripts', 'source-preview-allowlist.json');

/**
 * Reviewed false positives of the ADDITIONAL detectors (gitleaks, trufflehog) —
 * never of the release audit, whose BENIGN_ERE stays the one vendor-key rule.
 * An entry matches one exact (detector, rule, path, secret-hash): a changed or new
 * value in the same file is a new finding. Every entry must carry a reason.
 * @returns {Promise<{ detector: string, rule: string, path: string, sha256: string, reason: string }[]>}
 */
export async function loadAllowlist(path = ALLOWLIST_PATH) {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(await fs.readFile(path, 'utf8'));
  const entries = Array.isArray(parsed) ? parsed : parsed.entries;
  if (!Array.isArray(entries)) throw new PreviewError(`${path}: expected { entries: [...] }`, 2);
  for (const e of entries) {
    for (const k of ['detector', 'rule', 'path', 'sha256', 'reason']) {
      if (typeof e[k] !== 'string' || !e[k].trim()) throw new PreviewError(`${path}: every entry needs a non-empty ${k} (${JSON.stringify(e).slice(0, 200)})`, 2);
    }
    if (!/^[0-9a-f]{64}$/.test(e.sha256)) throw new PreviewError(`${path}: sha256 must be 64 hex chars (${e.path})`, 2);
  }
  return entries;
}

export function isAllowlisted(entries, f) {
  return entries.some((e) => e.detector === f.detector && e.rule === f.rule && e.path === f.path && e.sha256 === f.sha256);
}

/**
 * The tree a drift check compares, written into `gitDir` from `tree`: the snapshot with
 * its identity neutralized — MANIFEST.json dropped, and the source commit that NOTICE
 * and README.md name replaced by a placeholder. So a superproject commit that
 * changes nothing the preview ships is not drift (git-sync commits every few minutes),
 * while a changed shipped file, NOTICE or README text, or a hand edit on the
 * preview still is. A tree without a readable MANIFEST.json compares as-is. All three
 * files sit at the root, so only the root tree is rewritten.
 * @returns {{ comparable: string, sourceCommit: string | null }}
 */
function comparableTree(gitDir, tree) {
  const g = (args, opts) => run('git', ['--git-dir', gitDir, ...args], opts);
  const entries = g(['ls-tree', '-z', tree]).split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    const [mode, type, sha] = line.slice(0, tab).split(' ');
    return { mode, type, sha, name: line.slice(tab + 1) };
  });
  const manifest = entries.find((e) => e.name === 'MANIFEST.json' && e.type === 'blob');
  let sourceCommit = null;
  try { sourceCommit = manifest ? JSON.parse(g(['cat-file', 'blob', manifest.sha]))?.source?.commit ?? null : null; } catch { sourceCommit = null; }
  if (typeof sourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(sourceCommit)) return { comparable: tree, sourceCommit: null };
  const kept = entries.filter((e) => e !== manifest).map((e) => {
    if (e.type !== 'blob' || !['NOTICE', 'README.md'].includes(e.name)) return e;
    const text = g(['cat-file', 'blob', e.sha]);
    return { ...e, sha: g(['hash-object', '-w', '--stdin'], { input: text.split(sourceCommit).join('<source-commit>') }).trim() };
  });
  const comparable = g(['mktree', '-z'], { input: kept.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.name}\0`).join('') }).trim();
  return { comparable, sourceCommit };
}

/** The git tree a directory would commit as (every file, ignore rules overridden), and its comparable tree. */
export function exportTrees(dir) {
  const gitDir = join(tmpdir(), `source-preview-tree-${process.pid}-${Date.now()}`);
  try {
    run('git', ['init', '-q', '--bare', gitDir]);
    const base = ['--git-dir', gitDir, '--work-tree', dir, '-c', 'core.autocrlf=false', '-c', 'core.fileMode=true'];
    run('git', [...base, 'add', '-A', '-f', '.']);
    const tree = run('git', [...base, 'write-tree']).trim();
    return { tree, ...comparableTree(gitDir, tree) };
  } finally {
    spawnSync('rm', ['-rf', gitDir]);
  }
}

/** The tree at `branch` of `remote` and its comparable tree, or null when the branch does not exist. */
export function remoteTrees(remote, branch = 'main') {
  const gitDir = join(tmpdir(), `source-preview-remote-${process.pid}-${Date.now()}`);
  try {
    run('git', ['init', '-q', '--bare', gitDir]);
    const heads = run('git', ['--git-dir', gitDir, 'ls-remote', remote, `refs/heads/${branch}`]).trim();
    if (!heads) return null;
    run('git', ['--git-dir', gitDir, 'fetch', '-q', '--depth', '1', remote, `refs/heads/${branch}`]);
    const tree = run('git', ['--git-dir', gitDir, 'rev-parse', 'FETCH_HEAD^{tree}']).trim();
    const head = run('git', ['--git-dir', gitDir, 'rev-parse', 'FETCH_HEAD^{commit}']).trim();
    return { tree, head, ...comparableTree(gitDir, tree) };
  } finally {
    spawnSync('rm', ['-rf', gitDir]);
  }
}

/**
 * Compare the remote preview with a fresh export of `ref`.
 * @param {{ repoRoot?: string, ref?: string, remote?: string, target?: string, licensePath?: string, env?: NodeJS.ProcessEnv, selectScript?: string, log?: Log, thirdPartyNotices?: (dir: string) => { text: string, undetermined: string[] } }} [opts]
 */
export async function checkDrift({ repoRoot = ROOT, ref = DEFAULT_REF, remote, target = 'preview', licensePath, env = process.env, selectScript, log = () => {}, thirdPartyNotices } = {}) {
  const t = resolveTarget(target);
  remote = remote ?? defaultRemote(t);
  assertRemoteMatchesTarget(t, remote);
  const work = await mkdtemp(join(tmpdir(), 'source-preview-check-'));
  try {
    const { out, manifest } = await exportSnapshot({ repoRoot, ref, out: join(work, 'export'), target, licensePath, env, selectScript, log, thirdPartyNotices });
    const expected = exportTrees(out).comparable;
    const current = remoteTrees(remote);
    const actual = current?.comparable ?? null;
    return { inSync: expected === actual, expected, actual, commit: manifest.source.commit, previewCommit: current?.sourceCommit ?? null };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Render `Co-authored-by:` trailers for the public sync commit (open-source-release P-011).
 * Accepted outside pull requests are ported into the private development tree, whose
 * commits are swept under one automation identity, so the contributor's credit has to
 * ride on the public commit that first ships their change. Each entry must be exactly
 * `Name <email>`: one line, no control characters, one angle-bracketed address — anything
 * else is refused rather than written into a commit message verbatim.
 * @param {string[]} [coAuthors]
 * @returns {string} '' when there are none, else a blank line plus one trailer per author
 */
export function coAuthorTrailers(coAuthors = []) {
  const seen = new Set();
  const lines = [];
  for (const raw of coAuthors) {
    const value = String(raw ?? '').trim();
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(value) || !/^[^<>@]+ <[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>$/.test(value)) {
      throw new PreviewError(`--co-author must be "Name <email>" on one line (got ${JSON.stringify(value)})`, 2);
    }
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`Co-authored-by: ${value}`);
  }
  return lines.length ? `\n\n${lines.join('\n')}` : '';
}

/**
 * Re-export, re-gate, and (with confirm) publish. The preview target is REPLACED by one
 * parentless commit (force push); the public target gets a new commit on top of its current
 * main, pushed without --force, so a concurrent push is refused rather than overwritten.
 * The gate runs before anything is committed; a failing gate pushes nothing.
 * @param {{ repoRoot?: string, ref?: string, remote?: string, target?: string, licensePath?: string, confirm?: boolean, env?: NodeJS.ProcessEnv, selectScript?: string, gate?: Gate, log?: Log, thirdPartyNotices?: (dir: string) => { text: string, undetermined: string[] }, coAuthors?: string[] }} [opts]
 */
export async function pushSnapshot({
  repoRoot = ROOT, ref = DEFAULT_REF, remote, target = 'preview', licensePath, confirm = false,
  env = process.env, selectScript, gate, log = () => {}, thirdPartyNotices, coAuthors = [],
} = {}) {
  const t = resolveTarget(target);
  remote = remote ?? defaultRemote(t);
  assertRemoteMatchesTarget(t, remote);
  // The public target also typechecks the cut the way its CI will (WI-10006584).
  gate = gate ?? defaultGateFor(t);
  // Validate credit BEFORE any export work, so a malformed --co-author costs nothing.
  const trailers = coAuthorTrailers(coAuthors);
  const work = await mkdtemp(join(tmpdir(), 'source-preview-push-'));
  try {
    const { out, manifest } = await exportSnapshot({ repoRoot, ref, out: join(work, 'export'), target, licensePath, env, selectScript, log, thirdPartyNotices });
    log('gating the export');
    const verdict = await gate(out, { env });
    if (!verdict.ok) return { pushed: false, reason: 'gate', verdict, commit: manifest.source.commit };
    const { tree, comparable } = exportTrees(out);
    const current = remoteTrees(remote);
    // An append target's main must be export lineage: its head carries MANIFEST.json with a
    // source commit. Anything else is the wrong repository, and appending would publish the
    // export on top of someone else's history (D-016). Checked before the dry-run return so a
    // dry run reports it too.
    if (t.history === 'append' && current && current.sourceCommit === null) {
      throw new PreviewError(`refusing to append to ${remote}: its main (${current.head}) is not an export commit (no MANIFEST.json source.commit) — wrong repository?`, 2);
    }
    if (current?.comparable === comparable) {
      return { pushed: false, reason: 'in-sync', verdict, tree, commit: manifest.source.commit, previewCommit: current.sourceCommit };
    }
    if (!confirm) return { pushed: false, reason: 'dry-run', verdict, tree, commit: manifest.source.commit };
    const gitDir = join(work, 'repo.git');
    run('git', ['init', '-q', '--bare', gitDir]);
    const base = ['--git-dir', gitDir, '--work-tree', out, '-c', 'core.autocrlf=false', '-c', 'core.fileMode=true'];
    run('git', [...base, 'add', '-A', '-f', '.']);
    const written = run('git', [...base, 'write-tree']).trim();
    const identity = { GIT_AUTHOR_NAME: 'Papercusp', GIT_AUTHOR_EMAIL: t.email, GIT_COMMITTER_NAME: 'Papercusp', GIT_COMMITTER_EMAIL: t.email };
    const append = t.history === 'append';
    const parentArgs = [];
    if (append && current) {
      // The parent must exist in this object store for commit-tree; a depth-1 fetch is
      // enough, and the push then sends only the new commit and its new objects.
      run('git', ['--git-dir', gitDir, 'fetch', '-q', '--depth', '1', remote, 'refs/heads/main']);
      const parent = run('git', ['--git-dir', gitDir, 'rev-parse', 'FETCH_HEAD^{commit}']).trim();
      if (parent !== current.head) throw new PreviewError(`public main moved during the push (${current.head} → ${parent}); re-run`);
      parentArgs.push('-p', parent);
    }
    const message = (append
      ? `Sync from ${SOURCE_REPO}@${manifest.source.commit.slice(0, 12)}\n\nPublic-safe source cut, gated. See MANIFEST.json, LICENSE and NOTICE.`
      : `Source preview of ${SOURCE_REPO}@${manifest.source.commit.slice(0, 12)}\n\nPublic-safe source cut, gated. See MANIFEST.json and NOTICE.`)
      + trailers;
    const commit = run('git', ['--git-dir', gitDir, 'commit-tree', written, ...parentArgs, '-m', message], { env: { ...process.env, ...identity } }).trim();
    run('git', ['--git-dir', gitDir, 'push', '-q', ...(append ? [] : ['--force']), remote, `${commit}:refs/heads/main`]);
    const after = remoteTrees(remote);
    if (after?.tree !== written || after?.head !== commit) throw new PreviewError(`push verification failed: remote main ${after?.head ?? 'missing'} (tree ${after?.tree ?? '-'}) ≠ ${commit} (tree ${written})`);
    return { pushed: true, verdict, tree: written, pushedCommit: commit, parent: parentArgs[1] ?? null, commit: manifest.source.commit };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { _: [], coAuthors: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--' && cmd === 'verifier-run') { opts.command = rest.slice(i + 1); break; }
    else if (a === '--confirm') opts.confirm = true;
    else if (a === '--runtime-artifacts') opts.runtimeArtifacts = true;
    else if (a === '--git-checkout') opts.gitCheckout = true;
    else if (a === '--tauri-inputs') opts.tauriInputs = true;
    else if (a === '--co-author') opts.coAuthors.push(rest[++i]);
    else if (['--inputs-file', '--budget-from', '--child-estimate-ms', '--operator-api-root', '--operator-api-source-receipt',
      '--operator-api-source-sha', '--operator-api-inputs', '--operator-api-inputs-sha'].includes(a)) {
      const path = rest[++i];
      if (!path || path.startsWith('--')) throw new PreviewError(`missing value for ${a}`, 2);
      opts[a.slice(2)] = path;
    }
    else if (['--ref', '--out', '--remote', '--json', '--target', '--repo', '--inputs', '--receipt'].includes(a)) opts[a.slice(2)] = rest[++i];
    else if (a.startsWith('--')) throw new PreviewError(`unknown flag ${a}`, 2);
    else opts._.push(a);
  }
  return { cmd, opts };
}

function printGate(verdict) {
  for (const r of verdict.results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}: ${r.status}`);
    if (!r.ok && r.detail) console.log(r.detail.split('\n').map((l) => `      ${l}`).join('\n'));
  }
}

async function main(argv) {
  const { cmd, opts } = parseArgs(argv);
  const log = (m) => console.error(`==> ${m}`);
  if (cmd === 'verifier-run') {
    if (!opts.repo || !opts.ref || !opts.receipt || !(opts.inputs || opts['inputs-file']) || !opts.command?.length)
      throw new PreviewError('verifier-run requires --repo, --ref, --receipt, --inputs or --inputs-file and -- <command>', 2);
    return runVerifierCommand({ repo: opts.repo, ref: opts.ref, receiptPath: opts.receipt,
      inputs: opts.inputs?.split(',').filter(Boolean) ?? [], inputsFile: opts['inputs-file'],
      tauriInputs: opts.tauriInputs === true, command: opts.command,
      budgetFrom: opts['budget-from'], childEstimateMs: opts['child-estimate-ms'] === undefined ? 0 : Number(opts['child-estimate-ms']) });
  }
  if (cmd === 'verifier-inputs-check') {
    if (!opts.repo || !opts.ref || !(opts.inputs || opts['inputs-file'])) {
      throw new PreviewError('verifier input check requires --repo, --ref and --inputs or --inputs-file', 2);
    }
    const result = await validateVerifierInputs({ repo: opts.repo, ref: opts.ref,
      inputs: opts.inputs?.split(',').filter(Boolean) ?? [], inputsFile: opts['inputs-file'], tauriInputs: opts.tauriInputs === true });
    // This command runs inside the private dependency snapshot before the
    // native child. A stable census alone cannot detect an incomplete donor.
    const failures = findUnusableRuntimeDeps({ repoRoot: opts.repo });
    if (failures.length) throw new PreviewError(formatRuntimeFailures(failures), 2);
    console.log(JSON.stringify(result));
    return 0;
  }
  if (cmd === 'verifier-measure') {
    if (!opts.repo || !opts.ref) throw new PreviewError('verifier measurement requires explicit --repo and --ref', 2);
    console.log(measureVerifierSourceBytes({ repo: opts.repo, ref: opts.ref }));
    return 0;
  }
  if (cmd === 'verifier-prepare' || cmd === 'verifier-verify') {
    if (!opts.out || !opts.receipt) throw new PreviewError('verifier source requires --out and --receipt', 2);
    if (cmd === 'verifier-prepare') {
      if (!opts.repo || !opts.ref || !(opts.inputs || opts['inputs-file'])) {
        throw new PreviewError('verifier preparation requires explicit --repo, --ref and --inputs or --inputs-file', 2);
      }
      const receipt = await prepareVerifierSource({ repo: opts.repo, ref: opts.ref, dest: opts.out,
        inputs: opts.inputs?.split(',').filter(Boolean) ?? [], inputsFile: opts['inputs-file'], gitCheckout: opts.gitCheckout === true,
        tauriInputs: opts.tauriInputs === true,
        ...(Object.keys(opts).some(key => key.startsWith('operator-api-')) ? { operatorApi: {
          root: opts['operator-api-root'], sourceReceiptPath: opts['operator-api-source-receipt'],
          sourceReceiptSha256: opts['operator-api-source-sha'], inputReceiptPath: opts['operator-api-inputs'],
          inputReceiptSha256: opts['operator-api-inputs-sha'], outputPath: join(dirname(opts.receipt), 'operator-api-preflight.json'),
        } } : {}) });
      await fs.writeFile(opts.receipt, `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o600 });
    }
    await verifyVerifierSource(opts.out, JSON.parse(await fs.readFile(opts.receipt, 'utf8')),
      { runtimeArtifacts: opts.runtimeArtifacts === true });
    return 0;
  }
  if (cmd === 'licenses') {
    const census = await auditPublicRepositoryLicenses({ log });
    if (opts.json) await fs.writeFile(opts.json, `${JSON.stringify(census, null, 2)}\n`);
    console.log(census.summary);
    return census.exitCode;
  }
  loadReleaseHost();
  const target = resolveTarget(opts.target ?? 'preview');
  const remote = opts.remote ?? defaultRemote(target);
  const REPO = target.repo;
  if (cmd === 'export') {
    const out = opts.out ?? join(ROOT, '.papercusp', 'scratch', 'source-preview', `export-${target.key}-${Date.now()}`);
    const { manifest } = await exportSnapshot({ ref: opts.ref ?? DEFAULT_REF, out, target: target.key, log });
    console.log(`exported ${manifest.fileCount} files of ${SOURCE_REPO}@${manifest.source.commit} (+${manifest.submodules.length} submodules) → ${out}`);
    return 0;
  }
  if (cmd === 'gate') {
    const dir = opts._[0];
    if (!dir) throw new PreviewError('usage: gate <dir>', 2);
    const verdict = await defaultGateFor(target)(dir, {});
    printGate(verdict);
    // --json writes every finding (rule, path, line, sha256 — never the secret) for
    // reviewing new false positives into scripts/source-preview-allowlist.json.
    if (opts.json) await fs.writeFile(opts.json, `${JSON.stringify(verdict.findings ?? [], null, 2)}\n`);
    console.log(verdict.ok ? 'GATE: clean' : `GATE: refused (exit ${verdict.exitCode})`);
    return verdict.exitCode;
  }
  if (cmd === 'check') {
    const r = await checkDrift({ ref: opts.ref ?? DEFAULT_REF, remote, target: target.key, log });
    console.log(r.inSync
      ? `in sync: ${REPO} (snapshot of ${r.previewCommit}) ships the same content as a fresh export of ${SOURCE_REPO}@${r.commit}`
      : `DRIFT: ${REPO} ${r.actual ? `(snapshot of ${r.previewCommit ?? 'unknown'})` : '(no main branch)'} differs from a fresh export of ${SOURCE_REPO}@${r.commit} — run npm run preview:push${target.key === 'public' ? ' -- --target public' : ''}`);
    return r.inSync ? 0 : 1;
  }
  if (cmd === 'push') {
    const r = await pushSnapshot({ ref: opts.ref ?? DEFAULT_REF, remote, target: target.key, confirm: Boolean(opts.confirm), log, coAuthors: opts.coAuthors });
    printGate(r.verdict);
    if (r.reason === 'gate') { console.log('REFUSED: the gate found problems — nothing was pushed'); return r.verdict.exitCode; }
    if (r.reason === 'in-sync') { console.log(`already in sync: ${REPO} (snapshot of ${r.previewCommit}) ships the same content as ${SOURCE_REPO}@${r.commit} — nothing to push`); return 0; }
    if (r.reason === 'dry-run') { console.log(`dry run: would ${target.history === 'append' ? 'append a commit to' : 'replace'} ${REPO} main with tree ${r.tree} (${SOURCE_REPO}@${r.commit}). Re-run with --confirm.`); return 0; }
    console.log(`pushed ${r.pushedCommit}${r.parent ? ` (parent ${r.parent})` : ''} (tree ${r.tree}) = ${SOURCE_REPO}@${r.commit} → ${REPO}`);
    return 0;
  }
  console.error('usage: source-preview.mjs export|gate|check|push|licenses [--target preview|public] [--ref <ref>] [--out <dir>] [--remote <url>] [--json <file>] [--confirm] [--co-author "Name <email>"]...');
  return 2;
}

if (isCliEntry(import.meta.url)) {
  // Let pending stdout/stderr writes drain, including large piped receipts.
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    console.error(`ERROR: ${err.message}`);
    process.exitCode = err instanceof PreviewError ? err.exitCode : 2;
  });
}

export { main as runCli };
