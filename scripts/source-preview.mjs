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
// Sustainable Use License 1.0, APPEND-ONLY; the preview is replaced wholesale. See TARGETS.
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
import { admitTaskDeadline, readTaskDeadlineEpochMs } from './lib/task-deadline.mjs';
import { PRIVATE_TEST_PG_RELEASE_TOKEN_ENV, requestPrivateTestPgRelease } from './lib/with-test-pg-cleanup.mjs';
import { createProgressAwareWatchdog } from './lib/batch-watchdog.mjs';
import { processGroupLifetime } from '@papercusp/operator-core/lib/fleet/process-group-lifetime';
import { readProcessIdentity } from '@papercusp/operator-core/lib/process-identity';
import { sealRuntimeSourceHandle } from '@papercusp/operator-core/lib/blind-review-source-seal';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, appendFileSync, closeSync, existsSync, fstatSync, ftruncateSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { papercuspHome } from '@papercusp/host-platform/home';
import { mkdtemp, rm } from 'node:fs/promises';
import { constants, homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix as posixPath, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire, isBuiltin } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { compileFunction } from 'node:vm';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { verifierSourceFiles, verifierGitCheckoutSync, verifyVerifierSourceSync as verifyArchivedSourceSync, VerifierSourceError, writeVerifierTaskReceipt, verifierResourceInventory } from '@papercusp/operator-core/lib/verifier-source';
import { NOTICES_FILE, collectThirdPartyNotices } from './check-licenses.mjs';
import { runTreeRestrictedHoldPreflight, formatTreeRestrictedHoldRefusal,
  RESTRICTED_HOLD_PREFLIGHT_ENV, RESTRICTED_HOLD_PREFLIGHT_ADMITTED_BY_ROUTER } from './lib/restricted-hold-preflight.mjs';
import { applyEnvLocal, PG_URL_ENV_VARS } from './lib/pg-url.mjs';
import { findUnusableRuntimeDeps, formatRuntimeFailures } from './check-declared-deps-extracted.mjs';
import { writeOperatorArtifactManifest } from '@papercusp/operator-core/lib/release/operator-artifact';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const PREVIEW_REPO = 'Papercusp/papercusp-preview';
// NOT 'Papercusp/papercusp': that name is the private libs/papercusp library repo
// (open-source-release-2026-09-29 D-016), and an append push there would stack the export
// on top of the library's own history.
export const PUBLIC_REPO = 'Papercusp/papercusp-app';
export const SOURCE_REPO = 'Papercusp/papercup';
export const DEFAULT_REMOTE = `https://github.com/${PREVIEW_REPO}.git`;
export const DEFAULT_REF = 'main';
/** The public application's license (owner-approved SUL transition, 2026-10-26). */
export const PUBLIC_LICENSE_PATH = join(ROOT, 'scripts', 'public-release', 'LICENSE');
export const PUBLIC_LICENSE_ID = 'LicenseRef-Sustainable-Use-1.0';

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

const git = (repo, args, opts) => {
  // Verifier snapshots can live below the Git worktree they attest. Our paths
  // are repository-root relative, so keep ls-tree from silently scoping itself
  // to that nested current-directory prefix.
  const rootScopedArgs = args[0] === 'ls-tree' && !args.includes('--full-tree')
    ? [args[0], '--full-tree', ...args.slice(1)] : args;
  return run('git', ['-C', repo, ...rootScopedArgs], opts);
};

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
 * Reuses the public export's canonical SUL, existing components' ELv2, and Apache text.
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
    [digest(readFileSync(PUBLIC_LICENSE_PATH))]: PUBLIC_LICENSE_ID,
    // Independently released components retain ELv2 and their previously granted rights.
    [digest(readFileSync(join(ROOT, 'apps/operator-public/cupboard-actions/LICENSE')))]: 'ELv2',
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
        if (license && row.repo.toLowerCase() === PUBLIC_REPO.toLowerCase() && license !== PUBLIC_LICENSE_ID) {
          row.errors.push(`Application release requires SUL 1.0: ${file.path}`);
        }
        if (license && ['goals', 'cupboard-actions', 'blueprints', 'sidestage', 'scout-runtime', 'recipes', 'plans', 'scout-chat', 'drawer-stack', 'cart-drawer', 'data-fetch'].includes(row.repo.split('/')[1].toLowerCase()) && license !== 'ELv2') {
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
// Retain the object owner so contract readers can read pinned submodule bytes.
function committedInputObject(repo, sha, path, trees, optional = false) {
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
  if (link) return committedInputObject(materializedSubmodule(repo, link, link.path),
    link.sha, path.slice(link.path.length + 1), trees, optional);
  if (optional && !entries.has(path)) return null;
  const [mode, type, blob] = entries.get(path) ?? [];
  if (type !== 'blob' || !['100644', '100755'].includes(mode)) {
    throw new PreviewError(`tested input is not a regular committed file: ${path}`, 2);
  }
  return { repo, blob };
}

function committedInputBlob(repo, sha, path, trees) {
  const input = committedInputObject(repo, sha, path, trees);
  assert.ok(input, 'Committed input must be present');
  return input.blob;
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
  'scripts/run-operator-e2e-isolated.sh',
  'scripts/lib/operator-e2e-assertion.sh',
  'scripts/lib/verify-tauri-assertion-env.mjs',
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
  'scripts/lib/task-deadline.mjs',
  'scripts/lib/verify-tauri-deadline.mjs',
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

/** @typedef {{ completedTrees: number, totalTrees: number, currentTree: string, cacheHit?: boolean }} VerifierDependencyProgress */
/** @typedef {{ copyMode: 'copy' | 'hardlink', generationSnapshotSupported: boolean, explicitGeneration?: boolean,
 *   command: 'snapshot-locked' | 'snapshot-generation-locked' }} VerifierSnapshotSelection */
/** @typedef {{ snapshotSelection?: VerifierSnapshotSelection }} VerifierPhaseMetadata */
/** @typedef {(<T>(phase: string, operation: () => T | Promise<T>, metadata?: VerifierPhaseMetadata) => Promise<T>) & {
 *   reportProgress?: (phase: 'deps.census' | 'deps.postverify', progress: VerifierDependencyProgress) => void
 * }} VerifierPhaseRunner */

/** Device numbers alone do not distinguish Linux bind mounts: link(2) returns
 * EXDEV across them even on one filesystem. Unknown mount identity uses copies.
 * @param {string} donor
 * @param {string} dest
 * @returns {'copy' | 'hardlink'}
 */
function verifierDependencyCopyMode(donor, dest) {
  const sourceFd = openSync(donor, 'r');
  let targetFd;
  try {
    targetFd = openSync(dest, 'r');
    if (fstatSync(sourceFd).dev !== fstatSync(targetFd).dev) return 'copy';
    if (process.platform === 'linux') {
      const mountId = fd => readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8').match(/^mnt_id:\s*(\d+)$/m)?.[1];
      const sourceMount = mountId(sourceFd), targetMount = mountId(targetFd);
      if (!sourceMount || sourceMount !== targetMount) return 'copy';
    }
    return 'hardlink';
  } finally {
    if (targetFd !== undefined) closeSync(targetFd);
    closeSync(sourceFd);
  }
}

/** Keep the verifier's snapshot path selection explicit and independently checkable.
 * @param {VerifierSnapshotSelection['copyMode']} copyMode
 * @param {boolean} generationSnapshotSupported
 * @param {boolean} [explicitGeneration]
 * @returns {VerifierSnapshotSelection}
 */
export function selectVerifierDependencySnapshot(copyMode, generationSnapshotSupported, explicitGeneration = false) {
  assert.ok(['copy', 'hardlink'].includes(copyMode), 'Invalid verifier dependency copy mode');
  assert.equal(typeof generationSnapshotSupported, 'boolean', 'Invalid generation snapshot capability');
  assert.equal(typeof explicitGeneration, 'boolean', 'Invalid explicit generation selection');
  if (explicitGeneration && !generationSnapshotSupported)
    throw new PreviewError('selected source does not support immutable verifier generations', 2);
  return { copyMode, generationSnapshotSupported, ...(explicitGeneration ? { explicitGeneration } : {}),
    command: (copyMode === 'copy' || explicitGeneration) && generationSnapshotSupported
      ? 'snapshot-generation-locked' : 'snapshot-locked' };
}

function assertVerifierSnapshotSelection(selection) {
  assert.deepEqual(selection,
    selectVerifierDependencySnapshot(selection?.copyMode, selection?.generationSnapshotSupported, selection?.explicitGeneration),
    'Verifier snapshot selection metadata does not match its route inputs');
}

/** The writer and historical budget reader accept the same progress contract. */
function assertVerifierDependencyProgress(progress) {
  assert.deepEqual(Object.keys(progress ?? {}).filter(key => key !== 'cacheHit').sort(), ['completedTrees', 'currentTree', 'totalTrees'],
    'Verifier dependency progress must remain bounded');
  assert.ok(!Object.hasOwn(progress, 'cacheHit') || typeof progress.cacheHit === 'boolean',
    'Verifier dependency cacheHit must be boolean');
  assert.ok(Number.isSafeInteger(progress.completedTrees) && Number.isSafeInteger(progress.totalTrees) &&
    progress.totalTrees > 0 && progress.totalTrees <= 1000 &&
    progress.completedTrees >= 0 && progress.completedTrees <= progress.totalTrees &&
    typeof progress.currentTree === 'string' && progress.currentTree.length > 0 &&
    progress.currentTree.length <= 256, 'Invalid verifier dependency progress');
}

/** Append outside the owned tree synchronously: a blocked event loop or SIGKILL
 * must leave the last started phase readable without claiming it completed.
 * Mirror exact records into the existing checkpoint-log store so temporary
 * receipt cleanup cannot erase a later command's reviewed budget evidence.
 * @param {string} path
 * @param {NodeJS.ProcessEnv} env
 * @param {string} childDiagnosticsPath
 * @returns {VerifierPhaseRunner & { archivePath: string }}
 */
export function verifierPhaseRunner(path, env, childDiagnosticsPath) {
  writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
  const archiveDir = env.PAPERCUSP_CHECKPOINT_LOG_DIR || join(papercuspHome(env), 'checkpoint-logs');
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  const archivePath = join(archiveDir,
    `verifier-phases-${createHash('sha256').update(resolve(path)).digest('hex')}.jsonl`);
  writeFileSync(archivePath, '', { flag: 'wx', mode: 0o600 });
  const started = performance.now();
  let sequence = 0;
  const record = (phase, event, fields = {}) => {
    const bytes = `${JSON.stringify({
      schemaVersion: 'verifier-phase-v1', sequence: ++sequence,
      taskId: env.PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID ?? null,
      phase, event, elapsedMs: Math.round(performance.now() - started), ...fields,
    })}\n`;
    appendFileSync(archivePath, bytes);
    appendFileSync(path, bytes);
  };
  const active = new Set();
  const reportProgress = (phase, progress) => {
    assert.ok(active.has(phase) && ['deps.census', 'deps.postverify'].includes(phase),
      'Verifier dependency progress requires an active census phase');
    assertVerifierDependencyProgress(progress);
    record(phase, 'progress', { progress });
  };
  const run = async (phase, operation, metadata) => {
    if (metadata !== undefined) {
      assert.equal(phase, 'deps.snapshot', 'Only the snapshot phase accepts route metadata');
      assert.deepEqual(Object.keys(metadata).sort(), ['snapshotSelection'],
        'Verifier phase metadata must remain bounded');
      assertVerifierSnapshotSelection(metadata.snapshotSelection);
    }
    const before = performance.now();
    record(phase, 'started', metadata ?? {});
    active.add(phase);
    try {
      const result = await operation();
      record(phase, 'completed', { durationMs: Math.round(performance.now() - before),
        ...(['source.admission', 'child.admission'].includes(phase) ? { budget: result } : {}),
        ...(phase === 'child.run' ? { exitCode: result, diagnosticsPath: childDiagnosticsPath } : {}) });
      return result;
    } catch (error) {
      record(phase, 'failed', { durationMs: Math.round(performance.now() - before),
        ...(phase === 'child.run' ? { diagnosticsPath: childDiagnosticsPath } : {}),
        error: String(error?.message ?? error).slice(0, 2000) });
      throw error;
    } finally {
      active.delete(phase);
    }
  };
  return Object.assign(run, { archivePath, reportProgress });
}

/** Retain bounded child tails outside the cleaned source tree, including failures
 * before a fixture can allocate its own worker artifacts. Open exclusively and
 * verify each path still names its original file before publishing the receipt.
 * @param {string} receiptPath
 */
function verifierChildDiagnostics(receiptPath) {
  const limit = 64 * 1024;
  const files = [];
  const create = path => {
    const file = { path, fd: openSync(path, 'wx', 0o600), tail: Buffer.alloc(0), totalBytes: 0 };
    files.push(file);
    return file;
  };
  const close = () => { for (const file of files) closeSync(file.fd); };
  const write = (file, bytes) => {
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(file.fd, bytes, offset, bytes.length - offset, offset);
      if (!written) throw new Error('Verifier child diagnostics write made no progress');
      offset += written;
    }
    ftruncateSync(file.fd, bytes.length);
  };
  let receipt, stdout, stderr;
  try {
    receipt = create(`${receiptPath}.child.json`);
    stdout = create(`${receiptPath}.stdout.log`);
    stderr = create(`${receiptPath}.stderr.log`);
    write(receipt, Buffer.from(JSON.stringify({ schemaVersion: 'verifier-child-v1', status: 'started',
      stdout: { path: stdout.path }, stderr: { path: stderr.path } }) + '\n'));
  } catch (error) { close(); throw error; }
  return {
    collect(stream, chunk) {
      const file = stream === 'stdout' ? stdout : stderr;
      file.totalBytes += chunk.length;
      file.tail = Buffer.concat([file.tail, chunk]).subarray(-limit);
      write(file, file.tail);
      process[stream].write(chunk);
    },
    finish(outcome) {
      try {
        for (const file of files) {
          const actual = lstatSync(file.path), opened = fstatSync(file.fd);
          if (!actual.isFile() || actual.dev !== opened.dev || actual.ino !== opened.ino)
            throw new Error(`Verifier child diagnostics path changed: ${file.path}`);
        }
        const summary = file => ({ path: file.path, totalBytes: file.totalBytes,
          retainedBytes: file.tail.length, truncated: file.totalBytes > file.tail.length });
        write(receipt, Buffer.from(JSON.stringify({ schemaVersion: 'verifier-child-v1',
          status: outcome.exitCode === null && outcome.signal === null ? 'incomplete' : 'completed',
          ...outcome, stdout: summary(stdout), stderr: summary(stderr) }) + '\n'));
      } finally { close(); }
    },
  };
}

/** Run a bounded dependency preflight without abandoning writers in its owned tree.
 * The maintained helpers emit measured byte, lock and completed-tree counters;
 * only increases extend the watchdog. Join its process group before cleanup.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, timeoutMs?: number, maxMs?: number,
 *   stallWindowMs?: number, extensionMs?: number, signal?: AbortSignal, cutoffEpochMs?: number | null, now?: () => number,
 *   resourceInventory?: ReturnType<typeof verifierResourceInventory> }} options
 */
export async function runVerifierDependencyCommand(command, args, { cwd, env,
  timeoutMs = 600_000, maxMs = 1_800_000, stallWindowMs = 150_000, extensionMs = 60_000, signal, cutoffEpochMs, now = Date.now, resourceInventory }) {
  if (signal?.aborted) throw new PreviewError('verifier dependency preflight canceled before launch', 2);
  const deadline = readTaskDeadlineEpochMs(env);
  if (deadline !== null) maxMs = Math.min(maxMs, deadline - now() - 10_000);
  if (cutoffEpochMs != null) {
    if (!Number.isSafeInteger(cutoffEpochMs) || cutoffEpochMs <= 0)
      throw new PreviewError('invalid verifier preparation cutoff', 2);
    maxMs = Math.min(maxMs, cutoffEpochMs - now());
  }
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
    if (resourceInventory) {
      const identity = readProcessIdentity(child.pid);
      assert.ok(identity, 'Verifier helper original process identity unavailable');
      resourceInventory.record({ id: `process:${child.pid}:${identity}`, kind: 'process',
        pid: child.pid, processIdentity: identity, processGroup: child.pid });
    }
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

/** The expected population comes from the parent's accepted evidence, never
 * the candidate or compiler metafile. `path` retains the original artifact
 * bytes; `members` is the independently accepted literal source-blob map.
 * @typedef {{ path: string, evidenceRef: string, sha256: string, schemaVersion: 1,
 *   members: Record<string, string> }} BgAcceptedManifest
 * @typedef {{ schemaVersion: 'bg-verifier-source-v1', root: string,
 *   acceptedManifest: BgAcceptedManifest,
 *   source: Awaited<ReturnType<typeof prepareVerifierSource>>,
 *   sourceReceiptSha256: string }} BgVerifierPreparation
 */

/** @param {BgAcceptedManifest} expected @param {string} root */
function readBgAcceptedManifest(expected, root) {
  assert.ok(expected && typeof expected === 'object', 'BG parent manifest authority is UNKNOWN');
  assert.ok(typeof expected.evidenceRef === 'string' && expected.evidenceRef.trim()
    && !/^(?:unknown|absent|unresolved)$/i.test(expected.evidenceRef.trim()),
  'BG parent manifest authority is UNKNOWN');
  assert.equal(expected.schemaVersion, 1, 'BG parent manifest schema mismatch');
  assert.match(expected.sha256 ?? '', /^[a-f0-9]{64}$/, 'BG parent manifest digest is required');
  assert.ok(typeof expected.path === 'string' && isAbsolute(expected.path), 'BG parent manifest path is required');
  assertOutsideArchive(root, expected.path);
  assert.ok(lstatSync(expected.path).isFile() && realpathSync(expected.path) === expected.path,
    'BG parent manifest must be an independent regular file');
  const bytes = readFileSync(expected.path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256, 'BG parent manifest digest mismatch');
  const manifest = JSON.parse(String(bytes));
  assert.equal(manifest.schemaVersion, expected.schemaVersion, 'BG parent manifest schema mismatch');
  assert.ok(expected.members && typeof expected.members === 'object' && !Array.isArray(expected.members)
    && Object.keys(expected.members).length > 0, 'BG parent manifest members are required');
  for (const [path, blob] of Object.entries(expected.members)) {
    assert.ok(path && !isAbsolute(path) && !path.includes('\\')
      && !path.includes('\0') && path.split('/').every(part => part && part !== '.' && part !== '..'),
    'BG parent manifest member path is invalid');
    assert.match(blob, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, 'BG parent manifest source blob is invalid');
  }
  assert.deepEqual(manifest.sourceBlobs, expected.members, 'BG parent manifest literal membership mismatch');
  return bytes;
}

/** Retain a detached, recursively immutable expectation. Mutation of a caller's
 * descriptor or the returned receipt must not bless a later source population.
 * @template T @param {T} value @returns {T}
 */
function freezeBgExpectation(value) {
  const copy = JSON.parse(JSON.stringify(value));
  const freeze = item => {
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(copy);
}

/** Prepare through the maintained Git exporter, with original parent authority
 * resolved BEFORE it creates a destination. No build or activation is implied.
 * @param {{ repo: string, ref: string, dest: string, inputs: string[],
 *   acceptedManifest: BgAcceptedManifest }} options
 * @returns {Promise<BgVerifierPreparation>}
 */
export async function prepareBgVerifierSource({ repo, ref, dest, inputs, acceptedManifest }) {
  readBgAcceptedManifest(acceptedManifest, dest);
  const accepted = freezeBgExpectation(acceptedManifest);
  const members = Object.keys(accepted.members).sort();
  assert.deepEqual([...inputs].sort(), members, 'BG accepted input membership mismatch');
  const selected = resolveCommit(repo, ref);
  const trees = new Map();
  for (const path of members) {
    assert.equal(committedInputBlob(repo, selected, path, trees), accepted.members[path],
      `BG accepted input blob mismatch: ${path}`);
  }
  const source = await prepareVerifierSource({ repo, ref: selected, dest, inputs: members, gitCheckout: true });
  try {
    const sourceReceiptSha256 = createHash('sha256')
      .update(readFileSync(join(dest, '.verifier-source.json'))).digest('hex');
    /** @type {BgVerifierPreparation} */
    const prepared = freezeBgExpectation({ schemaVersion: 'bg-verifier-source-v1', root: realpathSync(dest),
      acceptedManifest: accepted, source, sourceReceiptSha256 });
    verifyBgVerifierSource(prepared, 'before-build');
    return prepared;
  } catch (error) {
    // prepareVerifierSource created this previously absent destination. Leave
    // the parent evidence and any peer/active/rollback generations untouched.
    await fs.rm(dest, { recursive: true, force: true });
    throw error;
  }
}

/** Reuse at both compiler boundaries. The original receipt is never regenerated
 * from observed output; dependencies and compiler-consumed bytes require their
 * separate custody checks before this source proof can qualify a build.
 * @param {BgVerifierPreparation} prepared
 * @param {'before-build' | 'before-publication'} boundary
 */
export function verifyBgVerifierSource(prepared, boundary) {
  assert.ok(['before-build', 'before-publication'].includes(boundary), 'BG compiler boundary is invalid');
  assert.equal(prepared.schemaVersion, 'bg-verifier-source-v1', 'BG preparation schema mismatch');
  const { root, source, acceptedManifest } = prepared;
  assert.equal(realpathSync(root), root, 'BG source root identity changed');
  readBgAcceptedManifest(acceptedManifest, root);
  assert.equal(createHash('sha256').update(readFileSync(join(root, '.verifier-source.json'))).digest('hex'),
    prepared.sourceReceiptSha256, 'BG original source receipt changed');
  assert.deepEqual(source.testedInputs.map(row => row.path).sort(), Object.keys(acceptedManifest.members).sort(),
    'BG accepted input membership mismatch');
  verifyVerifierSourceSync(root, source, { runtimeArtifacts: true });
  const trees = new Map();
  for (const [path, blob] of Object.entries(acceptedManifest.members)) {
    assert.equal(committedInputBlob(root, source.sourceCommit, path, trees), blob,
      `BG accepted input blob mismatch: ${path}`);
  }
  return prepared;
}

/** Bind esbuild's actual onLoad result to the original source/dependency census.
 * Endpoint fences alone miss an A-to-B-to-A rewrite. Hash the buffer returned
 * to esbuild, and retain that same buffer as its contents; never reopen it after
 * validation. Retain original file identities across the whole compile interval
 * as well: resolver metadata can select different original-censused bytes while
 * restoring its content before endpoint hashes run. Retain ancestor directory
 * identities too: originally absent metadata can be created for resolution and
 * removed before publication without changing any censused file. Compiler
 * invocation/toolchain identity and runtime external imports still require
 * their separate qualification boundaries.
 * @param {{ prepared: BgVerifierPreparation,
 *   dependencies: ReturnType<typeof captureVerifierDependencies> }} options
 */
export function createBgVerifierCompilerCustody({ prepared, dependencies }) {
  return bgVerifierCompilerCustody({ prepared, dependencies }, (boundary, original) => {
    verifyBgVerifierSource(prepared, boundary);
    assert.deepEqual(captureVerifierDependencies({ dest: prepared.root, receipt: prepared.source }), original,
      'BG compiler dependency census changed');
  });
}

/** Compose checks within one synchronous boundary, never across phase awaits.
 * The callback is private: callers cannot supply a cached or skipped fence.
 * @param {Parameters<typeof createBgVerifierCompilerCustody>[0]} options
 * @param {(boundary: 'before-build' | 'before-publication',
 *   original: ReturnType<typeof captureVerifierDependencies>) => void} verifyBoundary
 */
function bgVerifierCompilerCustody({ prepared, dependencies }, verifyBoundary) {
  const original = freezeBgExpectation(dependencies);
  assert.equal(original.root, prepared.root, 'BG compiler dependency root mismatch');
  verifyBoundary('before-build', original);
  const files = new Map(prepared.source.files.map(row => [row.path, row]));
  for (const tree of original.trees) for (const row of tree.files) {
    const path = `${tree.path}/${row.path}`;
    assert.ok(!files.has(path), `BG compiler duplicate input: ${path}`);
    files.set(path, { ...row, path });
  }
  /** @param {string} local */
  const inputIdentity = local => {
    const path = join(prepared.root, local);
    const stat = lstatSync(path, { bigint: true });
    return { physical: realpathSync(path), dev: stat.dev, ino: stat.ino,
      mode: stat.mode, nlink: stat.nlink, size: stat.size,
      mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
  };
  const originalIdentities = new Map([...files.keys()].map(local => [local, inputIdentity(local)]));
  // Derive the protected directory population from retained inputs, never from
  // later directory discovery. Include physical ancestors of in-root links.
  // Generated-only output directories are outside this population, so ordinary
  // compiler output does not invalidate the original input directories.
  const directories = new Set(['.']);
  for (const [local, identity] of originalIdentities) {
    const physical = relative(prepared.root, identity.physical).split(sep).join('/');
    assert.ok(physical && physical !== '..' && !physical.startsWith('../') && !isAbsolute(physical),
      'BG compiler original input escaped selected generation');
    for (const path of [local, physical]) {
      let directory = dirname(path);
      while (directory !== '.') {
        directories.add(directory);
        directory = dirname(directory);
      }
    }
  }
  const originalDirectories = new Map([...directories].map(local => [local, inputIdentity(local)]));
  /** @type {Map<string, { path: string, realpath: string, sha256: string }>} */
  const consumed = new Map();
  /** Read once and validate the exact buffer handed to an evaluator/compiler.
   * @param {string} path */
  const readInput = path => {
    const physical = realpathSync(path);
    const local = relative(prepared.root, physical).split(sep).join('/');
    assert.ok(local && local !== '..' && !local.startsWith('../') && !isAbsolute(local),
      'BG compiler input escaped selected generation');
    const expected = files.get(local);
    assert.ok(expected?.kind === 'file', `BG compiler input is outside original census: ${local}`);
    const fd = openSync(physical, 'r');
    /** @type {Buffer} */
    let contents;
    try {
      const before = fstatSync(fd, { bigint: true });
      assert.ok(before.isFile(), 'BG compiler input must be regular');
      contents = readFileSync(fd);
      const after = fstatSync(fd, { bigint: true });
      assert.ok(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => before[key] === after[key])
        && realpathSync(path) === physical, `BG compiler input changed while reading: ${local}`);
    } finally { closeSync(fd); }
    const sha256 = createHash('sha256').update(contents).digest('hex');
    assert.equal(sha256, expected.sha256, `BG compiler consumed bytes mismatch: ${local}`);
    return { contents, identity: { path: local, realpath: physical, sha256 } };
  };
  // This plugin must precede any other onLoad provider. It fails closed for
  // unknown inputs/loaders instead of asking esbuild to read them unobserved.
  /** @type {import('esbuild').Plugin} */
  const plugin = { name: 'bg-original-input-custody', setup(build) {
    assert.equal(build.initialOptions.plugins?.[0], plugin, 'BG compiler custody must be the first plugin');
    assert.equal(build.initialOptions.stdin, undefined, 'BG compiler stdin is outside original census');
    build.onLoad({ filter: /.*/ }, ({ path, namespace }) => {
      assert.equal(namespace, 'file', 'BG compiler virtual input is outside original census');
      const { contents, identity } = readInput(path);
      const { path: local, realpath: physical } = identity;
      /** @type {Record<string, import('esbuild').Loader>} */
      const loaders = { js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx', json: 'json', css: 'css', txt: 'text' };
      const loader = build.initialOptions.loader?.['.' + local.split('.').at(-1)]
        ?? loaders[local.split('.').at(-1)];
      assert.ok(loader, `BG compiler input loader is UNKNOWN: ${local}`);
      consumed.set(local, identity);
      return { contents, loader, resolveDir: dirname(physical) };
    });
  } };
  return { plugin, readToolchainInput: readInput,
    consumed: () => freezeBgExpectation([...consumed.values()].sort((a, b) => a.path.localeCompare(b.path))),
    verifyBeforePublication() {
      verifyBoundary('before-publication', original);
      for (const [local, expected] of originalIdentities)
        assert.deepEqual(inputIdentity(local), expected, `BG compiler original input identity changed: ${local}`);
      for (const [local, expected] of originalDirectories)
        assert.deepEqual(inputIdentity(local), expected, `BG compiler original directory identity changed: ${local}`);
      assert.ok(consumed.size > 0, 'BG compiler consumed input proof is UNKNOWN');
      return freezeBgExpectation([...consumed.values()].sort((a, b) => a.path.localeCompare(b.path)));
    } };
}

/** @typedef {{ path: string, dev: string, ino: string }} BgDirectoryIdentity */
/** @typedef {{ builder: string, argv: string[], node: string, compiler: string,
 *   packageManager: string, configuration: string[], environment: Record<string, string>,
 *   outputNamespace?: { bank: BgDirectoryIdentity, stage: BgDirectoryIdentity } }} BgBuildInvocation
 */

/** Record actual command inputs before effects. The caller executes exactly this
 * argv and explicit environment; inherited ambient resolution is forbidden.
 * @param {BgVerifierPreparation} prepared @param {BgBuildInvocation} invocation
 */
function readBgBuildInvocation(prepared, invocation) {
  const identity = readBgFileIdentity;
  const builder = identity(invocation.builder), compiler = identity(invocation.compiler);
  assert.equal(builder.realpath, join(prepared.root, 'apps/operator/bin/bundle-host.sh'),
    'BG builder must be the maintained selected builder');
  for (const file of [builder, compiler]) {
    const local = relative(prepared.root, file.realpath);
    assert.ok(local && local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local),
      'BG builder/compiler escaped selected generation');
  }
  assert.ok(Array.isArray(invocation.argv) && invocation.argv.every(arg => typeof arg === 'string'),
    'BG build argv is UNKNOWN');
  assert.ok(invocation.environment.NODE_OPTIONS === '' && invocation.environment.NODE_PATH === '',
    'BG build ambient Node resolution is forbidden');
  assert.ok(Object.entries(invocation.environment).every(([key, value]) =>
    /^[A-Z_][A-Z0-9_]*$/.test(key) && typeof value === 'string'), 'BG build environment is invalid');
  const configuration = invocation.configuration.map(identity).sort((a, b) => a.path.localeCompare(b.path));
  assert.equal(new Set(configuration.map(row => row.path)).size, configuration.length, 'BG build configuration duplicated');
  for (const file of configuration) {
    const local = relative(prepared.root, file.realpath).split(sep).join('/');
    assert.ok(prepared.source.files.some(row => row.path === local && row.sha256 === file.sha256),
      'BG build configuration is outside original source census');
  }
  if (invocation.outputNamespace) {
    for (const expected of [invocation.outputNamespace.bank, invocation.outputNamespace.stage])
      assert.deepEqual(readBgDirectoryIdentity(expected.path), expected, 'BG build output namespace changed');
  }
  return { builder, compiler, node: identity(invocation.node), packageManager: identity(invocation.packageManager),
    ...(invocation.outputNamespace ? { outputNamespace: invocation.outputNamespace } : {}),
    argv: [...invocation.argv], configuration,
    environment: Object.fromEntries(Object.entries(invocation.environment).sort(([a], [b]) => a.localeCompare(b))) };
}

/** A distinct, detached invocation record, never a restamped source receipt.
 * @param {{ prepared: BgVerifierPreparation, dependencies: ReturnType<typeof captureVerifierDependencies>,
 *   invocation: BgBuildInvocation }} options
 */
export function prepareBgVerifierBuildRecord({ prepared, dependencies, invocation }) {
  verifyBgVerifierSource(prepared, 'before-build');
  assert.deepEqual(captureVerifierDependencies({ dest: prepared.root, receipt: prepared.source }), dependencies,
    'BG build dependency census changed');
  return freezeBgExpectation({ schemaVersion: 'bg-build-invocation-v1', prepared, dependencies,
    originalSourceReceiptSha256: prepared.sourceReceiptSha256,
    invocation: readBgBuildInvocation(prepared, invocation) });
}

/** The same original command and physical identities fence both boundaries.
 * @param {ReturnType<typeof prepareBgVerifierBuildRecord>} record
 * @param {BgBuildInvocation} invocation
 * @param {'before-build' | 'before-publication'} boundary
 */
export function verifyBgVerifierBuildRecord(record, invocation, boundary) {
  assert.equal(record.schemaVersion, 'bg-build-invocation-v1', 'BG build record is UNKNOWN');
  verifyBgVerifierSource(record.prepared, boundary);
  assert.equal(record.originalSourceReceiptSha256, record.prepared.sourceReceiptSha256,
    'BG build record original receipt changed');
  assert.deepEqual(readBgBuildInvocation(record.prepared, invocation), record.invocation,
    'BG builder configuration or toolchain identity changed');
  assert.deepEqual(captureVerifierDependencies({ dest: record.prepared.root, receipt: record.prepared.source }), record.dependencies,
    'BG build dependency census changed');
  return record;
}

/** Translate only the maintained host recipe's compiler switches. Unknown
 * switches refuse before loading the compiler or creating output. Keep the
 * original argv in the build record; this translation never replaces it.
 * @param {string[]} argv @param {string} root
 */
function bgCompilerOptions(argv, root) {
  /** @type {import('esbuild').BuildOptions} */
  const options = { absWorkingDir: root, entryPoints: [], write: false };
  /** @type {string | undefined} */
  let metafile;
  for (const arg of argv) {
    if (!arg.startsWith('-')) { options.entryPoints.push(arg); continue; }
    const flag = { '--bundle': 'bundle', '--minify-whitespace': 'minifyWhitespace',
      '--minify-syntax': 'minifySyntax', '--keep-names': 'keepNames' }[arg];
    if (flag) { options[flag] = true; continue; }
    const scalar = /^--(platform|format|target|outfile|log-level|log-limit)=(.+)$/s.exec(arg);
    if (scalar) {
      const key = { 'log-level': 'logLevel', 'log-limit': 'logLimit' }[scalar[1]] ?? scalar[1];
      options[key] = scalar[1] === 'log-limit' ? Number(scalar[2]) : scalar[2];
      continue;
    }
    if (arg.startsWith('--metafile=')) { metafile = arg.slice(11); options.metafile = true; continue; }
    if (arg.startsWith('--external:')) { (options.external ??= []).push(arg.slice(11)); continue; }
    const mapping = /^--(define|alias|banner):([^=]+)=(.*)$/s.exec(arg);
    if (mapping) { (options[mapping[1]] ??= {})[mapping[2]] = mapping[3]; continue; }
    throw new Error(`BG compiler switch is outside maintained recipe: ${arg}`);
  }
  assert.equal(options.entryPoints.length, 1, 'BG compiler requires exactly one maintained entry');
  assert.ok(options.outfile, 'BG compiler output path is required');
  const ownedPath = path => {
    const output = resolve(root, path), local = relative(root, output);
    assert.ok(local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`),
      'BG compiler output escaped selected generation');
    // Refuse existing directory-link parents as well as lexical escapes.
    let parent = dirname(output);
    while (!existsSync(parent)) parent = dirname(parent);
    const physical = realpathSync(parent), inside = relative(root, physical);
    assert.ok(inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside),
      'BG compiler output escaped selected generation');
    return output;
  };
  options.outfile = ownedPath(options.outfile);
  if (metafile !== undefined) metafile = ownedPath(metafile);
  return { options, metafile };
}

/** Keep the common source/dependency receipt once, with a separate original
 * command for every maintained main/worker/spawner invocation. Commands are
 * selected by their complete argv, never by entry basename or call order.
 * @param {{ prepared: BgVerifierPreparation, dependencies: ReturnType<typeof captureVerifierDependencies>,
 *   invocations: BgBuildInvocation[] }} args
 */
export function prepareBgVerifierBuildContexts({ prepared, dependencies, invocations }) {
  assert.ok(Array.isArray(invocations) && invocations.length > 0, 'BG invocation set is empty');
  const record = prepareBgVerifierBuildRecord({ prepared, dependencies, invocation: invocations[0] });
  return readBgVerifierBuildContexts(record, invocations);
}

/** Capture command identities after the caller has checked the common input
 * cohort in THIS synchronous validation. Never retain an input-validation cache
 * across boundaries, compiler calls or publication operations.
 * @param {ReturnType<typeof prepareBgVerifierBuildRecord>} record
 * @param {BgBuildInvocation[]} invocations
 */
function readBgVerifierBuildContexts(record, invocations) {
  const context = freezeBgExpectation({ schemaVersion: 'bg-build-contexts-v1', record,
    invocations: invocations.map(invocation => ({ invocation, original: readBgBuildInvocation(record.prepared, invocation) })) });
  validateBgVerifierBuildContexts(context);
  return context;
}

/** @param {ReturnType<typeof prepareBgVerifierBuildContexts>} context */
function validateBgVerifierBuildContexts(context) {
  assert.equal(context.schemaVersion, 'bg-build-contexts-v1', 'BG invocation set is UNKNOWN');
  assert.ok(Array.isArray(context.invocations) && context.invocations.length > 0, 'BG invocation set is empty');
  assert.deepEqual(context.invocations[0].original, context.record.invocation,
    'BG invocation set changed first build record');
  const common = ({ argv, ...identity }) => identity;
  const commands = new Set(), outputs = new Set();
  for (const entry of context.invocations) {
    assert.deepEqual(common(entry.original), common(context.record.invocation),
      'BG invocation set changed common build identity');
    assert.deepEqual(entry.invocation.argv, entry.original.argv, 'BG invocation set changed original argv');
    const key = JSON.stringify(entry.original.argv);
    assert.ok(!commands.has(key), 'BG invocation set duplicated command');
    commands.add(key);
    const { options, metafile } = bgCompilerOptions(entry.original.argv, context.record.prepared.root);
    for (const output of [options.outfile, metafile].filter(Boolean)) {
      assert.ok(!outputs.has(output), 'BG invocation set duplicated output');
      outputs.add(output);
    }
  }
}

/** Refresh the shared source/dependency census once per boundary, while still
 * reading EVERY command's actual toolchain, configuration and namespace. The
 * structural common-identity check must precede this deduplication: later
 * invocations cannot borrow the first command's authority.
 * @param {ReturnType<typeof prepareBgVerifierBuildContexts>} context
 * @param {'before-build' | 'before-publication'} boundary
 */
function verifyBgVerifierBuildContexts(context, boundary) {
  validateBgVerifierBuildContexts(context);
  verifyBgVerifierBuildRecord(context.record, context.invocations[0].invocation, boundary);
  for (const entry of context.invocations.slice(1))
    assert.deepEqual(readBgBuildInvocation(context.record.prepared, entry.invocation), entry.original,
      'BG builder configuration or toolchain identity changed');
}

/** @param {ReturnType<typeof prepareBgVerifierBuildContexts>} context
 * @param {string[]} argv
 */
function selectBgVerifierBuildContext(context, argv) {
  validateBgVerifierBuildContexts(context);
  const entry = context.invocations.find(row => JSON.stringify(row.original.argv) === JSON.stringify(argv));
  assert.ok(entry, 'BG compiler argv is outside original invocation set');
  return { record: { ...context.record, invocation: entry.original }, invocation: entry.invocation };
}

/** A caller nominates this namespace BEFORE the recipe knows its shell PID.
 * Follow release-artifacts.sh's physical producer-bank/absent-output contract.
 * The token may vary only in temporary output leaves; no observed compiler argv
 * can nominate commands, source inputs, switches, or logical output membership.
 * This is preparation for whole-recipe publication, not a publication receipt.
 * @param {{ prepared: BgVerifierPreparation, dependencies: ReturnType<typeof captureVerifierDependencies>,
 *   invocations: BgBuildInvocation[], bank: string, stageLeaf: string,
 *   outputs: { temporary: string, final: string }[], publicationLeaf?: string,
 *   assets?: { source: string, temporary: string, final: string }[],
 *   recipe?: { entry: string, outfile: string, profile: 'development' | 'release' } }} args
 */
export function prepareBgVerifierBuildTransaction({ prepared, dependencies, invocations, bank, stageLeaf, outputs, assets, recipe, publicationLeaf }) {
  const contexts = prepareBgVerifierBuildContexts({ prepared, dependencies, invocations });
  const bankIdentity = readBgDirectoryIdentity(bank);
  const local = relative(prepared.root, bank);
  assert.ok(local && local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local),
    'BG transaction bank escaped selected generation');
  assert.match(stageLeaf, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'BG transaction stage leaf is invalid');
  const transaction = freezeBgExpectation({ schemaVersion: 'bg-build-transaction-v1', contexts,
    bank: bankIdentity, stage: join(bank, stageLeaf), outputs, ...(assets === undefined ? {} : { assets }), ...(recipe ? { recipe } : {}),
    ...(publicationLeaf === undefined ? {} : { publicationLeaf }) });
  validateBgVerifierBuildTransaction(transaction);
  assert.ok(!existsSync(transaction.stage) && !isBgSymlink(transaction.stage), 'BG transaction stage already exists');
  if (publicationLeaf !== undefined) assert.ok(!existsSync(join(bank, publicationLeaf))
    && !isBgSymlink(join(bank, publicationLeaf)), 'BG transaction publication already exists');
  return transaction;
}

/** @param {string} path @returns {BgDirectoryIdentity} */
function readBgDirectoryIdentity(path) {
  assert.ok(isAbsolute(path) && realpathSync(path) === path, 'BG output directory must be physical');
  const stat = lstatSync(path, { bigint: true });
  assert.ok(stat.isDirectory(), 'BG output directory must be independent');
  return { path, dev: String(stat.dev), ino: String(stat.ino) };
}

/** existsSync deliberately follows links, so separately reject a dangling leaf.
 * @param {string} path */
function isBgSymlink(path) {
  try { return lstatSync(path).isSymbolicLink(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** @param {ReturnType<typeof prepareBgVerifierBuildTransaction>} transaction */
function validateBgVerifierBuildTransaction(transaction) {
  assert.equal(transaction.schemaVersion, 'bg-build-transaction-v1', 'BG transaction is UNKNOWN');
  const { contexts, bank, stage, outputs } = transaction;
  verifyBgVerifierBuildContexts(contexts, 'before-build');
  assert.deepEqual(readBgDirectoryIdentity(bank.path), bank, 'BG transaction bank identity changed');
  assert.equal(dirname(stage), bank.path, 'BG transaction stage escaped bank');
  assert.match(basename(stage), /^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'BG transaction stage leaf is invalid');
  if (transaction.publicationLeaf !== undefined) {
    assert.match(transaction.publicationLeaf, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'BG publication leaf is invalid');
    assert.notEqual(transaction.publicationLeaf, basename(stage), 'BG publication overlaps stage');
  }
  const safe = path => typeof path === 'string' && path && !isAbsolute(path)
    && !path.includes('\\') && !path.includes('\0')
    && path.split('/').every(part => part && part !== '.' && part !== '..');
  assert.ok(Array.isArray(outputs) && outputs.length > 0 && outputs.every(row =>
    safe(row.temporary) && safe(row.final) && !row.final.includes('@BG_PID@')),
  'BG transaction output membership is invalid');
  const assets = transaction.assets ?? [];
  assert.ok(Array.isArray(assets) && assets.every(row => safe(row.source) && safe(row.temporary) && safe(row.final)
    && !row.final.includes('@BG_PID@') && row.temporary === `${row.final}.new.@BG_PID@`),
  'BG transaction asset membership is invalid');
  for (const asset of assets) {
    const source = contexts.record.prepared.source.files.find(row => row.path === asset.source);
    assert.ok(source?.kind === 'file', 'BG asset source is outside original source census');
    assert.equal(realpathSync(join(contexts.record.prepared.root, asset.source)),
      join(contexts.record.prepared.root, asset.source), 'BG asset source must be physical');
  }
  const members = [...outputs, ...assets];
  const temporary = members.map(row => row.temporary), finals = members.map(row => row.final);
  assert.equal(new Set(temporary).size, temporary.length, 'BG transaction temporary output duplicated');
  assert.equal(new Set(finals).size, finals.length, 'BG transaction logical output duplicated');
  for (const paths of [temporary, finals]) {
    assert.ok(!paths.some(path => paths.some(other => other !== path && other.startsWith(`${path}/`))),
      'BG transaction file overlaps directory');
  }
  assert.ok(!temporary.some(path => finals.includes(path)), 'BG transaction temporary and logical outputs overlap');
  const compilerOutputs = [];
  for (const entry of contexts.invocations) {
    for (const arg of entry.original.argv) {
      if (arg.includes('@BG_PID@')) {
        const output = /^--(?:outfile|metafile)=(.+)$/.exec(arg)?.[1];
        assert.ok(output && !dirname(output).includes('@BG_PID@')
          && /\.(?:tmp|new)\.@BG_PID@(?:\.[A-Za-z0-9._-]+)?$/.test(basename(output))
          && output.split('@BG_PID@').length === 2,
        'BG transaction PID token is outside a temporary output leaf');
      }
    }
    const { options, metafile } = bgCompilerOptions(entry.original.argv, contexts.record.prepared.root);
    for (const path of [options.outfile, metafile].filter(Boolean)) {
      const local = relative(stage, path).split(sep).join('/');
      assert.ok(safe(local), 'BG transaction compiler output escaped stage');
      compilerOutputs.push(local);
    }
  }
  // Exact equality makes the original logical population authoritative.
  assert.deepEqual(compilerOutputs.sort(), outputs.map(row => row.temporary).sort(), 'BG transaction compiler output membership mismatch');
  if (transaction.recipe) {
    const { entry, outfile, profile } = transaction.recipe;
    const main = bgCompilerOptions(contexts.invocations[0].original.argv, contexts.record.prepared.root);
    assert.ok(isAbsolute(entry) && dirname(outfile) === stage && ['development', 'release'].includes(profile),
      'BG recipe original command is invalid');
    assert.deepEqual(main.options.entryPoints, [entry], 'BG recipe entry differs from original main invocation');
    assert.equal(main.options.outfile, `${outfile}.tmp.@BG_PID@`, 'BG recipe output differs from original main invocation');
    assert.ok(outputs.some(row => row.temporary === `${basename(outfile)}.tmp.@BG_PID@`
      && row.final === basename(outfile)), 'BG recipe logical main output differs from original membership');
  }
}

/** Bind a PID supplied by the recipe preflight, before its first compile.
 * The original caller contract is preserved beside the resulting exact argv.
 * Stage creation is exclusive: attach an existing attempt instead of replaying.
 * @param {{ transaction: ReturnType<typeof prepareBgVerifierBuildTransaction>, ownerPid: number }} args
 */
export function beginBgVerifierBuildTransaction({ transaction, ownerPid }) {
  validateBgVerifierBuildTransaction(transaction);
  assert.ok(Number.isSafeInteger(ownerPid) && ownerPid > 0, 'BG transaction owner PID is invalid');
  assert.ok(!existsSync(transaction.stage) && !isBgSymlink(transaction.stage), 'BG transaction stage already exists');
  // Never use recursive mkdir: it could adopt another attempt's stage.
  mkdirSync(transaction.stage, { mode: 0o700 });
  assert.deepEqual(readBgDirectoryIdentity(transaction.bank.path), transaction.bank, 'BG transaction bank identity changed');
  const outputNamespace = { bank: transaction.bank, stage: readBgDirectoryIdentity(transaction.stage) };
  const contexts = prepareBgVerifierBuildContexts({ ...transaction.contexts.record,
    invocations: transaction.contexts.invocations.map(entry => ({ ...entry.invocation, outputNamespace,
      argv: entry.original.argv.map(arg => arg.replaceAll('@BG_PID@', String(ownerPid))) })) });
  return freezeBgExpectation({ schemaVersion: 'bg-build-transaction-binding-v1', transaction,
    transactionSha256: createHash('sha256').update(JSON.stringify(transaction)).digest('hex'),
    ownerPid, contexts, outputs: transaction.outputs.map(row => ({ ...row,
      temporary: row.temporary.replaceAll('@BG_PID@', String(ownerPid)) })) });
}

/** Expand directory copies from the retained source census, before a caller
 * freezes its transaction. Never discover membership from a mutable directory
 * walk. `sql` matches the maintained builder's immediate *.sql copy; recursive
 * includes every censused descendant and refuses links instead of following them.
 * @param {{ prepared: BgVerifierPreparation,
 *   trees: { source: string, final: string, selection: 'recursive' | 'sql' }[] }} args
 */
export function expandBgVerifierAssetTrees({ prepared, trees }) {
  verifyBgVerifierSource(prepared, 'before-build');
  const safe = path => typeof path === 'string' && path && !isAbsolute(path)
    && !path.includes('\\') && !path.includes('\0') && !path.includes('@BG_PID@')
    && path.split('/').every(part => part && part !== '.' && part !== '..');
  assert.ok(Array.isArray(trees) && trees.length > 0, 'BG asset tree population is empty');
  const assets = [];
  for (const tree of trees) {
    assert.ok(safe(tree.source) && safe(tree.final) && ['recursive', 'sql'].includes(tree.selection),
      'BG asset tree selection is invalid');
    const source = join(prepared.root, tree.source);
    assert.ok(lstatSync(source).isDirectory() && realpathSync(source) === source,
      'BG asset tree source must be physical and regular');
    const prefix = `${tree.source}/`;
    const files = prepared.source.files.filter(row => row.path.startsWith(prefix))
      .filter(row => tree.selection === 'recursive'
        || (!row.path.slice(prefix.length).includes('/') && !row.path.slice(prefix.length).startsWith('.')
          && row.path.endsWith('.sql')))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    assert.ok(files.length > 0, 'BG asset tree has no original source members');
    for (const file of files) {
      assert.equal(file.kind, 'file', 'BG asset tree member must be a regular file');
      assert.equal(realpathSync(join(prepared.root, file.path)), join(prepared.root, file.path),
        'BG asset tree member must be physical');
      const final = `${tree.final}/${file.path.slice(prefix.length)}`;
      assert.ok(safe(final), 'BG asset tree output membership is invalid');
      assets.push({ source: file.path, temporary: `${final}.new.@BG_PID@`, final });
    }
  }
  const finals = assets.map(row => row.final);
  assert.equal(new Set(finals).size, finals.length, 'BG asset tree output duplicated');
  assert.ok(!finals.some(path => finals.some(other => other !== path && other.startsWith(`${path}/`))),
    'BG asset tree file overlaps directory');
  return freezeBgExpectation(assets);
}

/** Copy only the original transaction's source-censused ancillary files. The
 * very buffer checked against the original digest is written exclusively into
 * the owned stage; no hardlink, ambient directory tree or later read supplies
 * its bytes. Callers may expand retained directories with
 * expandBgVerifierAssetTrees before preparing the original transaction.
 * @param {ReturnType<typeof beginBgVerifierBuildTransaction>} binding
 */
export function stageBgVerifierAssetCopies(binding) {
  const { transaction, assets } = verifyBgVerifierOutputBinding(binding);
  const { root, source } = binding.contexts.record.prepared;
  for (const asset of assets) {
    const expected = source.files.find(row => row.path === asset.source);
    assert.ok(expected?.kind === 'file', 'BG asset source is outside original source census');
    const path = join(root, asset.source), fd = openSync(path, 'r');
    let contents;
    try {
      const before = fstatSync(fd, { bigint: true });
      assert.ok(before.isFile() && realpathSync(path) === path, 'BG asset source must be physical and regular');
      contents = readFileSync(fd);
      const after = fstatSync(fd, { bigint: true });
      assert.ok(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => before[key] === after[key])
        && realpathSync(path) === path, 'BG asset source changed while reading');
      assert.equal(createHash('sha256').update(contents).digest('hex'), expected.sha256,
        'BG asset consumed bytes mismatch');
    } finally { closeSync(fd); }
    let directory = transaction.stage;
    for (const part of dirname(asset.temporary).split('/').filter(part => part !== '.')) {
      directory = join(directory, part);
      try { mkdirSync(directory, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      readBgDirectoryIdentity(directory);
    }
    writeFileSync(join(transaction.stage, asset.temporary), contents, { flag: 'wx', mode: 0o600 });
  }
  // An empty asset set has no intervening copy effect to fence. Real copies
  // still require the closing source/dependency and namespace validation.
  if (assets.length > 0) verifyBgVerifierOutputBinding(binding);
}

/** Measure the COMPLETE temporary output population against the retained binding
 * and each compiler's receipt. This is a detached pre-publication fence: it
 * neither renames files nor authorizes service activation or runtime imports.
 * The caller must retain the returned record and recheck it at publication.
 * @param {{ binding: ReturnType<typeof beginBgVerifierBuildTransaction>,
 *   receipts: Awaited<ReturnType<typeof compileBgVerifierInvocation>>[] }} args
 */
export function qualifyBgVerifierBuildOutputSet({ binding, receipts }) {
  const { transaction, contexts, outputs, assets } = verifyBgVerifierOutputBinding(binding);
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  assert.ok(Array.isArray(receipts) && receipts.length === contexts.invocations.length,
    'BG output compiler receipt population mismatch');
  const commands = new Set();
  const identities = new Map();
  for (const entry of contexts.invocations) {
    const key = JSON.stringify(entry.original.argv);
    const matches = receipts.filter(receipt => JSON.stringify(receipt.argv) === key);
    assert.equal(matches.length, 1, 'BG output compiler receipt membership mismatch');
    const receipt = matches[0];
    assert.equal(receipt.schemaVersion, 'bg-compiler-invocation-v1', 'BG output compiler receipt is UNKNOWN');
    const record = { ...contexts.record, invocation: entry.original };
    assert.equal(receipt.buildRecordSha256, hash(record), 'BG output compiler original record changed');
    assert.equal(receipt.originalSourceReceiptSha256, record.originalSourceReceiptSha256,
      'BG output compiler original source receipt changed');
    const { options, metafile } = bgCompilerOptions(entry.original.argv, record.prepared.root);
    assert.equal(receipt.output.path, options.outfile, 'BG output compiler output path changed');
    assert.equal(receipt.metafile?.path, metafile, 'BG output compiler metafile path changed');
    for (const identity of [receipt.output, receipt.metafile].filter(Boolean)) {
      assert.deepEqual(readBgIndependentOutputIdentity(identity.path), identity, 'BG output compiler bytes changed');
      identities.set(relative(transaction.stage, identity.path).split(sep).join('/'), identity);
    }
    commands.add(key);
  }
  assert.equal(commands.size, receipts.length, 'BG output compiler command population mismatch');
  assert.deepEqual([...identities.keys()].sort(), binding.outputs.map(row => row.temporary).sort(),
    'BG output compiler file population mismatch');
  for (const asset of assets) {
    const expected = contexts.record.prepared.source.files.find(row => row.path === asset.source);
    const identity = readBgIndependentOutputIdentity(join(transaction.stage, asset.temporary));
    assert.equal(identity.sha256, expected?.sha256, 'BG output asset bytes differ from original source');
    identities.set(asset.temporary, identity);
  }
  const controls = new Map([
    ['.bg-build-binding.json', JSON.stringify(binding)],
    ['.bg-build-context.json', JSON.stringify(binding.contexts)],
  ]);
  const expected = new Set([...identities.keys(), ...[...controls.keys()].filter(path =>
    existsSync(join(transaction.stage, path)))]);
  assertBgOutputPopulation(transaction.stage, expected, controls);
  // Close the census with the same source, dependency and directory identities.
  verifyBgVerifierBuildContexts(contexts, 'before-publication');
  return freezeBgExpectation({ schemaVersion: 'bg-build-output-set-v1',
    transactionSha256: binding.transactionSha256, bindingSha256: hash(binding),
    compilerReceiptsSha256: hash(receipts), originalSourceReceiptSha256: contexts.record.originalSourceReceiptSha256,
    files: outputs.map(row => ({ ...row, identity: identities.get(row.temporary) })) });
}

/** @param {ReturnType<typeof beginBgVerifierBuildTransaction>} binding */
function verifyBgVerifierOutputBinding(binding) {
  assert.equal(binding.schemaVersion, 'bg-build-transaction-binding-v1', 'BG output binding is UNKNOWN');
  const { transaction, ownerPid } = binding;
  validateBgVerifierBuildTransaction(transaction);
  assert.ok(Number.isSafeInteger(ownerPid) && ownerPid > 0, 'BG output owner PID is invalid');
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  assert.equal(binding.transactionSha256, hash(transaction), 'BG output original transaction changed');
  const namespace = binding.contexts.record.invocation.outputNamespace;
  assert.ok(namespace && namespace.stage.path === transaction.stage, 'BG output original stage changed');
  assert.deepEqual(namespace.bank, transaction.bank, 'BG output original bank changed');
  // Transaction validation refreshed the common census above. Reconstruct the
  // exact PID-bound commands and read all live identities without rescanning
  // those same common inputs during this synchronous binding check.
  const invocations = transaction.contexts.invocations.map(entry => ({ ...entry.invocation, outputNamespace: namespace,
    argv: entry.original.argv.map(arg => arg.replaceAll('@BG_PID@', String(ownerPid))) }));
  const contexts = readBgVerifierBuildContexts({ ...transaction.contexts.record,
    invocation: readBgBuildInvocation(transaction.contexts.record.prepared, invocations[0]) }, invocations);
  assert.deepEqual(binding.contexts, contexts, 'BG output original contexts changed');
  const compilerOutputs = transaction.outputs.map(row => ({ ...row,
    temporary: row.temporary.replaceAll('@BG_PID@', String(ownerPid)) }));
  assert.deepEqual(binding.outputs, compilerOutputs, 'BG output original membership changed');
  const assets = (transaction.assets ?? []).map(row => ({ ...row,
    temporary: row.temporary.replaceAll('@BG_PID@', String(ownerPid)) }));
  const outputs = [...compilerOutputs, ...assets.map(({ temporary, final }) => ({ temporary, final }))];
  return { transaction, contexts, outputs, assets };
}

/** @param {string} stage @param {Set<string>} expected @param {Map<string, string>} [controls] */
function assertBgOutputPopulation(stage, expected, controls = new Map()) {
  const actual = [];
  const visit = (directory, prefix = '') => {
    for (const name of readdirSync(directory).sort()) {
      const path = prefix + name, absolute = join(directory, name), stat = lstatSync(absolute);
      assert.ok(!stat.isSymbolicLink(), 'BG output population contains a symlink');
      if (stat.isDirectory()) {
        assert.ok([...expected].some(file => file.startsWith(path + '/')),
          'BG output population contains an unrecorded directory');
        visit(absolute, path + '/');
      } else {
        assert.ok(stat.isFile() && stat.nlink === 1, 'BG output population requires independent regular files');
        actual.push(path);
        if (controls.has(path)) assert.equal(readFileSync(absolute, 'utf8'), controls.get(path),
          'BG output control record changed');
      }
    }
  };
  visit(stage);
  assert.deepEqual(actual.sort(), [...expected].sort(), 'BG output file population mismatch');
}

/** Re-measure without replacing the retained qualification record.
 * @param {ReturnType<typeof qualifyBgVerifierBuildOutputSet>} output
 * @param {Parameters<typeof qualifyBgVerifierBuildOutputSet>[0]} args
 */
export function verifyBgVerifierBuildOutputSet(output, args) {
  assert.deepEqual(qualifyBgVerifierBuildOutputSet(args), output, 'BG qualified output set changed');
  return output;
}

/** Convert only the qualified temporary files to their ORIGINAL logical names
 * inside the private stage. Exclusive links preserve compiler-created inodes
 * without overwriting another file; unlinking the temporary names restores
 * independent-file custody. A failure leaves an unpublished attempt for diagnosis.
 * The maintained artifact writer qualifies the original main entry in place.
 * @param {{ output: ReturnType<typeof qualifyBgVerifierBuildOutputSet> } &
 *   Parameters<typeof qualifyBgVerifierBuildOutputSet>[0]} args
 */
export async function qualifyBgVerifierLogicalOutputSet(args) {
  const { output, binding } = args;
  verifyBgVerifierBuildOutputSet(output, args);
  // The complete output fence just validated these same immutable records.
  const { transaction, contexts } = binding;
  const { stage } = transaction;
  const main = contexts.invocations[0];
  const mainOutput = bgCompilerOptions(main.original.argv, contexts.record.prepared.root).options.outfile;
  const entry = output.files.find(row => join(stage, row.temporary) === mainOutput);
  assert.ok(entry && transaction.recipe?.outfile === join(stage, entry.final), 'BG logical main output is UNKNOWN');
  for (const invocation of contexts.invocations) {
    const { options, metafile } = bgCompilerOptions(invocation.original.argv, contexts.record.prepared.root);
    const bundle = output.files.find(row => join(stage, row.temporary) === options.outfile);
    const meta = output.files.find(row => join(stage, row.temporary) === metafile);
    assert.ok(bundle && meta && meta.final === bundle.final + '.meta.json', 'BG logical metafile membership mismatch');
  }
  for (const row of output.files) {
    assert.equal(dirname(row.temporary), dirname(row.final), 'BG logical output directory changed');
    assert.ok(!existsSync(join(stage, row.final)) && !isBgSymlink(join(stage, row.final)),
      'BG logical output already exists');
  }
  for (const row of output.files) {
    linkSync(join(stage, row.temporary), join(stage, row.final));
    unlinkSync(join(stage, row.temporary));
  }
  const artifact = await qualifyBgVerifierOutput({ record: { ...contexts.record, invocation: main.original },
    invocation: main.invocation, entry: join(stage, entry.final) });
  const controls = ['.bg-build-binding.json', '.bg-build-context.json']
    .filter(path => existsSync(join(stage, path))).map(path => readBgIndependentOutputIdentity(join(stage, path)));
  const logical = freezeBgExpectation({ schemaVersion: 'bg-logical-output-set-v1',
    outputSetSha256: createHash('sha256').update(JSON.stringify(output)).digest('hex'),
    directory: readBgDirectoryIdentity(stage), artifact, controls,
    files: output.files.map(row => ({ temporary: row.temporary, final: row.final,
      identity: readBgIndependentOutputIdentity(join(stage, row.final)) })) });
  verifyBgVerifierLogicalOutputSet(logical, args);
  return logical;
}

/** Recheck retained logical outputs without regenerating a manifest or receipt.
 * @param {Awaited<ReturnType<typeof qualifyBgVerifierLogicalOutputSet>>} logical
 * @param {Parameters<typeof qualifyBgVerifierLogicalOutputSet>[0]} args
 */
export function verifyBgVerifierLogicalOutputSet(logical, { output, binding, receipts }) {
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const { transaction, contexts, outputs } = verifyBgVerifierOutputBinding(binding);
  assert.equal(logical.schemaVersion, 'bg-logical-output-set-v1', 'BG logical output record is UNKNOWN');
  assert.equal(logical.outputSetSha256, hash(output), 'BG logical original output record changed');
  assert.equal(output.bindingSha256, hash(binding), 'BG logical original binding changed');
  assert.equal(output.compilerReceiptsSha256, hash(receipts), 'BG logical compiler receipts changed');
  assert.deepEqual(logical.directory, readBgDirectoryIdentity(transaction.stage), 'BG logical stage changed');
  assert.deepEqual(logical.files.map(({ temporary, final }) => ({ temporary, final })), outputs,
    'BG logical output membership changed');
  for (const [index, row] of logical.files.entries()) {
    const original = output.files[index];
    assert.ok(original?.identity, 'BG logical original file is UNKNOWN');
    assert.equal(row.identity.path, join(transaction.stage, row.final), 'BG logical file path changed');
    // Renaming changes ctime; byte, inode and modification-time custody survive.
    for (const key of ['sha256', 'dev', 'ino', 'size', 'mtimeNs'])
      assert.equal(row.identity[key], original.identity[key], 'BG logical compiler file replaced');
    assert.deepEqual(readBgIndependentOutputIdentity(row.identity.path), row.identity, 'BG logical file changed');
  }
  const main = contexts.invocations[0];
  verifyBgVerifierOutputRecord(logical.artifact, { ...contexts.record, invocation: main.original }, main.invocation);
  const controls = new Map([['.bg-build-binding.json', JSON.stringify(binding)],
    ['.bg-build-context.json', JSON.stringify(binding.contexts)]]);
  for (const identity of logical.controls) {
    assert.ok(controls.has(relative(transaction.stage, identity.path)), 'BG logical control path changed');
    assert.deepEqual(readBgIndependentOutputIdentity(identity.path), identity, 'BG logical control changed');
  }
  assertBgOutputPopulation(transaction.stage, new Set([...outputs.map(row => row.final),
    ...logical.controls.map(row => relative(transaction.stage, row.path)),
    relative(transaction.stage, logical.artifact.manifest.path)]), controls);
  verifyBgVerifierBuildContexts(contexts, 'before-publication');
  return logical;
}

/** Publish one COMPLETE receipt at the pre-nominated bank leaf. Linking a fully
 * written private file is atomic and refuses an existing destination, including
 * dangling links. Keep artifact paths physical: moving this directory would
 * invalidate the maintained boot reader's manifest suffix check. This publishes
 * evidence only; activation must independently recheck the receipt and cohort.
 * @param {{ logical: Awaited<ReturnType<typeof qualifyBgVerifierLogicalOutputSet>> } &
 *   Parameters<typeof qualifyBgVerifierLogicalOutputSet>[0]} args
 */
export function publishBgVerifierLogicalOutputSet(args) {
  const { logical, binding, receipts, output } = args;
  const leaf = binding.transaction.publicationLeaf;
  assert.ok(leaf, 'BG publication destination was not originally nominated');
  assert.match(leaf, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'BG publication leaf is invalid');
  assert.deepEqual(readBgDirectoryIdentity(binding.transaction.bank.path), binding.transaction.bank,
    'BG publication bank changed');
  assert.deepEqual(readBgDirectoryIdentity(binding.transaction.stage), logical.directory,
    'BG publication stage changed');
  const path = join(binding.transaction.bank.path, leaf), temporary = path + '.tmp.' + binding.ownerPid;
  // Retain the original inputs needed by the publication verifier. A logical
  // output digest alone cannot reconstruct the compiler or transaction proof.
  const evidence = { schemaVersion: 'bg-build-publication-v1', logical, binding, receipts, output };
  const body = JSON.stringify(evidence);
  writeFileSync(temporary, body, { flag: 'wx', mode: 0o600 });
  try {
    verifyBgVerifierLogicalOutputSet(logical, args);
    linkSync(temporary, path);
  } finally { unlinkSync(temporary); }
  const publication = freezeBgExpectation({ ...evidence, identity: readBgIndependentOutputIdentity(path) });
  assert.equal(readFileSync(path, 'utf8'), body, 'BG publication content changed');
  return publication;
}

/** @param {ReturnType<typeof publishBgVerifierLogicalOutputSet>} publication
 * @param {Parameters<typeof publishBgVerifierLogicalOutputSet>[0]} args */
export function verifyBgVerifierPublication(publication, args) {
  assert.equal(publication.schemaVersion, 'bg-build-publication-v1', 'BG publication record is UNKNOWN');
  assert.equal(publication.identity.path, join(args.binding.transaction.bank.path,
    args.binding.transaction.publicationLeaf ?? ''), 'BG publication destination changed');
  assert.deepEqual(publication.logical, args.logical, 'BG publication logical record changed');
  for (const key of ['binding', 'receipts', 'output'])
    assert.deepEqual(publication[key], args[key], 'BG publication original evidence changed');
  assert.deepEqual(readBgIndependentOutputIdentity(publication.identity.path), publication.identity,
    'BG publication file changed');
  assert.equal(readFileSync(publication.identity.path, 'utf8'),
    JSON.stringify({ schemaVersion: publication.schemaVersion, logical: args.logical,
      binding: args.binding, receipts: args.receipts, output: args.output }), 'BG publication content changed');
  verifyBgVerifierLogicalOutputSet(args.logical, args);
  return publication;
}

/** Execute one retained recipe into an exclusively owned stage, then publish its
 * complete evidence. Re-entry always refuses the existing stage, including an
 * attempt whose compiler failed. There is no cache/fallback or service effect.
 * This does not establish the production runtime closure or authorize activation.
 * @param {Parameters<typeof beginBgVerifierBuildTransaction>[0] & { runPhase?: VerifierPhaseRunner,
 *   budget?: { measurements: Record<string, number>, env?: NodeJS.ProcessEnv, now?: () => number } }} args
 */
export async function runBgVerifierBuildRecipe(args) {
  const { transaction, budget, runPhase: tracePhase = async (_phase, operation) => operation() } = args;
  // Capture the caller's clock before the compiler replaces process.env. A
  // deadline-bearing run must forecast the whole recipe before any stage effect.
  const env = { ...(budget?.env ?? process.env) }, now = budget?.now ?? Date.now;
  assert.ok(budget || env.PAPERCUSP_TASK_DEADLINE_EPOCH_MS === undefined,
    'BG recipe deadline requires completed phase budget observations');
  const measurements = { ...budget?.measurements };
  /** @type {string[]} */
  const completedPhases = [];
  /** @type {{ phase: string, startedAtMs: number } | undefined} */
  let activePhase;
  const admit = () => {
    if (!budget) return;
    const estimate = estimateVerifierCommandBudget(measurements, 0, { bgRecipe: {
      invocationCount: transaction.contexts.invocations.length, completedPhases,
      ...(activePhase ? { activePhase: { phase: activePhase.phase,
        elapsedMs: Math.max(0, now() - activePhase.startedAtMs) } } : {}),
    } });
    admitVerifierCommandBudget(estimate, { env, nowMs: now() });
  };
  admit();
  /** @type {VerifierPhaseRunner} */
  const runPhase = async (phase, operation) => {
    const outer = phase.startsWith('bg.recipe.');
    // stop is unconditional cleanup, including when admission itself refuses.
    if (phase !== 'bg.compiler.stop') admit();
    const before = now();
    if (outer) activePhase = { phase, startedAtMs: before };
    try {
      const result = await tracePhase(phase, () => {
        if (phase !== 'bg.compiler.stop') admit();
        return operation();
      });
      measurements[phase] = Math.max(measurements[phase] ?? 0, Math.max(0, now() - before));
      if (outer) { completedPhases.push(phase); activePhase = undefined; }
      if (phase !== 'bg.compiler.stop') admit();
      return result;
    } finally {
      if (outer) activePhase = undefined;
    }
  };
  await runPhase('bg.recipe.validate', () => {
    validateBgVerifierBuildTransaction(transaction);
    assert.ok(transaction.publicationLeaf, 'BG recipe publication destination is UNKNOWN');
    const destination = join(transaction.bank.path, transaction.publicationLeaf);
    assert.ok(!existsSync(destination) && !isBgSymlink(destination), 'BG recipe publication already exists');
  });
  const binding = await runPhase('bg.recipe.begin', () => {
    const binding = beginBgVerifierBuildTransaction(args);
    writeBgVerifierBinding(binding);
    return binding;
  });
  const receipts = [];
  // Preserve original command order and record identity. A later compiler
  // failure leaves diagnostic temporary files but cannot publish a partial set.
  for (const entry of binding.contexts.invocations) {
    const record = { ...binding.contexts.record, invocation: entry.original };
    receipts.push(await runPhase(`bg.recipe.compiler.${receipts.length}`, () =>
      compileBgVerifierInvocation({ record, invocation: entry.invocation,
        argv: entry.invocation.argv, expectedVersion: '0.25.0', runPhase })));
  }
  await runPhase('bg.recipe.assets', () => stageBgVerifierAssetCopies(binding));
  const output = await runPhase('bg.recipe.output', () => qualifyBgVerifierBuildOutputSet({ binding, receipts }));
  const logical = await runPhase('bg.recipe.logical', () => qualifyBgVerifierLogicalOutputSet({ binding, receipts, output }));
  const retained = { binding, receipts, output, logical };
  const publication = await runPhase('bg.recipe.publish', () => publishBgVerifierLogicalOutputSet(retained));
  await runPhase('bg.recipe.verify', () => verifyBgVerifierPublication(publication, retained));
  return publication;
}

/** @param {ReturnType<typeof beginBgVerifierBuildTransaction>} binding */
function writeBgVerifierBinding(binding) {
  const stage = binding.transaction.stage;
  writeFileSync(join(stage, '.bg-build-binding.json'), JSON.stringify(binding), { flag: 'wx', mode: 0o600 });
  writeFileSync(join(stage, '.bg-build-context.json'), JSON.stringify(binding.contexts), { flag: 'wx', mode: 0o600 });
}

/** The shared shell recipe delegates one EXACT recorded compiler invocation
 * here. Use its private API and binary, pass the digest-checked buffers to
 * esbuild, then fence source/dependencies again before writing any output.
 * The compiler API is evaluated from its validated buffer with builtin-only
 * imports and no module cache. Its native service consumes a retained sealed
 * descriptor. Runtime imports, full host closure and service readiness remain separate.
 * @param {{ record: ReturnType<typeof prepareBgVerifierBuildRecord>,
 *   invocation: BgBuildInvocation, argv: string[], expectedVersion: string, runPhase?: VerifierPhaseRunner }} args
 */
export async function compileBgVerifierInvocation({ record, invocation, argv, expectedVersion,
  runPhase = async (_phase, operation) => operation() }) {
  await runPhase('bg.compiler.before-build', () => verifyBgVerifierBuildRecord(record, invocation, 'before-build'));
  assert.deepEqual(argv, record.invocation.argv, 'BG compiler argv differs from original invocation');
  const { options, metafile } = bgCompilerOptions(argv, record.prepared.root);
  const actualNode = await runPhase('bg.compiler.node', () => readBgFileIdentity(process.execPath));
  assert.ok(actualNode.realpath === record.invocation.node.realpath && actualNode.sha256 === record.invocation.node.sha256,
    'BG compiler actual Node differs from original invocation');
  const compilerRoot = dirname(dirname(invocation.compiler));
  assert.equal(invocation.compiler, join(compilerRoot, 'lib/main.js'), 'BG compiler requires its private esbuild API');
  const metadataPath = join(compilerRoot, 'package.json');
  const metadata = await runPhase('bg.compiler.metadata', () => JSON.parse(readFileSync(metadataPath, 'utf8')));
  assert.equal(metadata.name, 'esbuild', 'BG compiler package identity mismatch');
  assert.equal(metadata.version, expectedVersion, 'BG compiler package version mismatch');
  const binary = await runPhase('bg.compiler.binary', () => readBgFileIdentity(join(compilerRoot, 'bin/esbuild')));
  await runPhase('bg.compiler.toolchain-files', () => {
    for (const identity of [readBgFileIdentity(invocation.compiler), readBgFileIdentity(metadataPath), binary]) {
      const local = relative(record.prepared.root, identity.realpath).split(sep).join('/');
      const expected = record.dependencies.trees.flatMap(tree => tree.files.map(row =>
        ({ ...row, path: `${tree.path}/${row.path}` }))).find(row => row.path === local);
      assert.ok(expected?.kind === 'file' && expected.sha256 === identity.sha256,
        'BG compiler toolchain file is outside original dependency census');
    }
  });
  assert.equal(invocation.environment.ESBUILD_BINARY_PATH, binary.realpath, 'BG compiler binary must be explicitly pinned');
  assert.equal(invocation.environment.ESBUILD_WORKER_THREADS, '0', 'BG compiler requires its owned service process');
  const custody = await runPhase('bg.compiler.custody', () =>
    bgVerifierCompilerCustody({ prepared: record.prepared, dependencies: record.dependencies },
      (boundary, original) => verifyBgVerifierBuildRecord({ ...record, dependencies: original }, invocation, boundary)));
  const originalEnv = process.env;
  /** @type {typeof import('esbuild') | undefined} */
  let compiler;
  /** @type {import('node:fs/promises').FileHandle | undefined} */
  let sealedBinary;
  let binaryLaunches = 0;
  try {
    sealedBinary = await runPhase('bg.compiler.binary-seal', async () => {
      const original = await fs.open(binary.realpath, 'r');
      try {
        return await sealRuntimeSourceHandle(original, binary.sha256, Number((await original.stat()).size));
      } finally { await original.close(); }
    });
    const retainedBinary = sealedBinary;
    const sealedInfo = await retainedBinary.stat({ bigint: true });
    process.env = { ...invocation.environment };
    const compilerApi = await runPhase('bg.compiler.import', () => {
      const source = custody.readToolchainInput(invocation.compiler);
      const trustedRequire = createRequire(import.meta.url);
      // The pinned esbuild API needs only Node builtins when its native binary
      // is explicitly selected. Refuse package/ambient fallback before loading it.
      const builtinRequire = Object.assign(/** @param {string} name */ name => {
        assert.ok(isBuiltin(name), `BG compiler API import is outside Node builtins: ${name}`);
        if (name === 'child_process' || name === 'node:child_process') return {
          /** @param {string} command @param {string[]} args @param {import('node:child_process').SpawnOptions} spawnOptions */
          spawn(command, args, spawnOptions) {
            assert.equal(command, binary.realpath, 'BG compiler service command differs from original binary');
            assert.deepEqual(args, [`--service=${expectedVersion}`, '--ping'], 'BG compiler service argv differs');
            assert.deepEqual(spawnOptions.stdio, ['pipe', 'pipe', 'inherit'], 'BG compiler service stdio differs');
            assert.ok(!spawnOptions.shell, 'BG compiler service cannot use a shell');
            if (spawnOptions.env) assert.deepEqual(spawnOptions.env, invocation.environment,
              'BG compiler service environment differs');
            assert.equal(binaryLaunches++, 0, 'BG compiler service may launch only once');
            // fd 3 is explicitly inherited by the child. The pathname chosen by
            // esbuild stays bound above, but exec consumes the sealed A bytes even
            // if that original pathname temporarily names B during service startup.
            return spawn('/proc/self/fd/3', args, { ...spawnOptions,
              env: { ...invocation.environment }, stdio: ['pipe', 'pipe', 'inherit', retainedBinary.fd] });
          },
        };
        return trustedRequire(name);
      }, { resolve(/** @type {string} */ name) {
        assert.ok(isBuiltin(name), `BG compiler API resolution is outside Node builtins: ${name}`);
        return trustedRequire.resolve(name);
      } });
      const module = { exports: /** @type {typeof import('esbuild')} */ ({}) };
      // Do not reopen the path or consult Node's CJS/ESM caches after validation.
      compileFunction(source.contents.toString('utf8'), ['exports', 'require', 'module', '__filename', '__dirname'],
        { filename: invocation.compiler })(module.exports, builtinRequire, module,
        invocation.compiler, dirname(invocation.compiler));
      return { compiler: module.exports, identity: source.identity };
    });
    compiler = compilerApi.compiler;
    assert.equal(compiler.version, expectedVersion, 'BG compiler API version mismatch');
    const activeCompiler = compiler;
    const result = await runPhase('bg.compiler.build', () => activeCompiler.build({ ...options, plugins: [custody.plugin] }));
    const consumed = await runPhase('bg.compiler.verify', () => {
      assert.equal(binaryLaunches, 1, 'BG compiler native consumption is UNKNOWN');
      return custody.verifyBeforePublication();
    });
    return await runPhase('bg.compiler.output', async () => {
      // esbuild write:false leaves failed or incoherent attempts unpublished.
      for (const file of result.outputFiles ?? []) {
        assert.equal(file.path, options.outfile, 'BG compiler produced an unrecorded output');
        await fs.mkdir(dirname(file.path), { recursive: true });
        await fs.writeFile(file.path, file.contents, { flag: 'wx' });
      }
      assert.equal(result.outputFiles?.length, 1, 'BG compiler output is UNKNOWN');
      if (metafile) await fs.writeFile(metafile, JSON.stringify(result.metafile), { flag: 'wx' });
      return freezeBgExpectation({ schemaVersion: 'bg-compiler-invocation-v1', argv: record.invocation.argv,
        buildRecordSha256: createHash('sha256').update(JSON.stringify(record)).digest('hex'),
        originalSourceReceiptSha256: record.originalSourceReceiptSha256, compilerVersion: activeCompiler.version,
        compilerApi: compilerApi.identity, binary,
        compilerBinary: { kind: 'kernel-sealed-fd-v1', sha256: binary.sha256, bytes: String(sealedInfo.size),
          dev: String(sealedInfo.dev), ino: String(sealedInfo.ino), launches: binaryLaunches },
        consumed, output: readBgIndependentOutputIdentity(options.outfile),
        ...(metafile ? { metafile: readBgIndependentOutputIdentity(metafile) } : {}) });
    });
  } finally {
    try { await runPhase('bg.compiler.stop', async () => { await compiler?.stop(); }); }
    finally {
      try { await sealedBinary?.close(); }
      finally { process.env = originalEnv; }
    }
  }
}

/** Hash every byte without allocating a second copy of a toolchain executable.
 * Both identity readers retain their descriptor and metadata fences.
 * @param {number} fd
 * @param {bigint} size
 */
function hashBgFileDescriptor(fd, size) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(4 * 1024 * 1024, Number(size)) || 1);
  for (;;) {
    const count = readSync(fd, buffer, 0, buffer.length, null);
    if (count === 0) break;
    hash.update(buffer.subarray(0, count));
  }
  return hash.digest('hex');
}

/** Outputs must retain the actual compiler-created file, even if replacement
 * bytes happen to hash identically. Keep link and inode custody on the same FD
 * used for hashing; the final path must still name that independent file.
 * @param {string} path
 */
function readBgIndependentOutputIdentity(path) {
  assert.ok(isAbsolute(path) && realpathSync(path) === path, 'BG output must be physical');
  const fd = openSync(path, 'r');
  try {
    const before = fstatSync(fd, { bigint: true });
    assert.ok(before.isFile() && before.nlink === 1n, 'BG output must be an independent regular file');
    const sha256 = hashBgFileDescriptor(fd, before.size);
    const after = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'];
    assert.ok(named.isFile() && fields.every(key => before[key] === after[key] && after[key] === named[key])
      && realpathSync(path) === path, 'BG output changed while reading');
    return { path, realpath: path, sha256, dev: String(before.dev), ino: String(before.ino),
      size: String(before.size), mtimeNs: String(before.mtimeNs), ctimeNs: String(before.ctimeNs) };
  } finally { closeSync(fd); }
}

/** Read one physical file without reopening between validation and hashing.
 * @param {string} path
 */
function readBgFileIdentity(path) {
  assert.ok(isAbsolute(path), 'BG build identity requires an absolute path');
  const physical = realpathSync(path);
  const fd = openSync(physical, 'r');
  try {
    const before = fstatSync(fd, { bigint: true });
    assert.ok(before.isFile(), 'BG build identity must be a regular file');
    const sha256 = hashBgFileDescriptor(fd, before.size);
    const after = fstatSync(fd, { bigint: true });
    assert.ok(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => before[key] === after[key])
      && realpathSync(path) === physical, 'BG build identity changed while reading');
    return { path, realpath: physical, sha256 };
  } finally { closeSync(fd); }
}

/** Bind the maintained artifact writer's measured output to the ORIGINAL build
 * record. Builder exit status alone is never artifact qualification. This is a
 * separate output fence, not proof of compiler consumption or service readiness.
 * @typedef {{ schemaVersion: 'bg-build-output-v1', buildRecordSha256: string,
 *   originalSourceReceiptSha256: string, entry: ReturnType<typeof readBgFileIdentity>,
 *   manifest: ReturnType<typeof readBgFileIdentity>,
 *   artifact: Extract<import('@papercusp/operator-core/lib/release/operator-artifact').OperatorArtifactIdentity,
 *     { status: 'measured' }> }} BgVerifierOutputRecord
 * @param {{ record: ReturnType<typeof prepareBgVerifierBuildRecord>,
 *   invocation: BgBuildInvocation, entry: string }} options
 * @returns {Promise<BgVerifierOutputRecord>}
 */
export async function qualifyBgVerifierOutput({ record, invocation, entry }) {
  verifyBgVerifierBuildRecord(record, invocation, 'before-publication');
  const file = readBgFileIdentity(entry);
  const local = relative(record.prepared.root, file.realpath);
  assert.ok(file.path === file.realpath && local && !isAbsolute(local)
    && local !== '..' && !local.startsWith(`..${sep}`), 'BG output escaped selected generation');
  const artifact = await writeOperatorArtifactManifest({ root: record.prepared.root, entry,
    sourceSha: record.prepared.source.sourceCommit });
  assert.equal(artifact.status, 'measured', 'BG output artifact is UNKNOWN');
  if (artifact.status !== 'measured') throw new Error('BG output artifact is UNKNOWN');
  assert.deepEqual(artifact.sourceBlobs, record.prepared.acceptedManifest.members,
    'BG output accepted member census mismatch');
  /** @type {BgVerifierOutputRecord} */
  const output = freezeBgExpectation({ schemaVersion: 'bg-build-output-v1',
    buildRecordSha256: createHash('sha256').update(JSON.stringify(record)).digest('hex'),
    originalSourceReceiptSha256: record.originalSourceReceiptSha256,
    entry: file, manifest: readBgFileIdentity(artifact.evidenceRef), artifact });
  verifyBgVerifierOutputRecord(output, record, invocation);
  return output;
}

/** Recheck the same detached output immediately before publication; never
 * regenerate a source receipt, input record or manifest to bless replacement.
 * @param {BgVerifierOutputRecord} output
 * @param {ReturnType<typeof prepareBgVerifierBuildRecord>} record
 * @param {BgBuildInvocation} invocation
 */
export function verifyBgVerifierOutputRecord(output, record, invocation) {
  verifyBgVerifierBuildRecord(record, invocation, 'before-publication');
  assert.equal(output.schemaVersion, 'bg-build-output-v1', 'BG output record is UNKNOWN');
  assert.equal(output.buildRecordSha256, createHash('sha256').update(JSON.stringify(record)).digest('hex'),
    'BG output original build record mismatch');
  assert.equal(output.originalSourceReceiptSha256, record.originalSourceReceiptSha256,
    'BG output original source receipt mismatch');
  assert.deepEqual(readBgFileIdentity(output.entry.path), output.entry, 'BG output bundle changed');
  assert.deepEqual(readBgFileIdentity(output.manifest.path), output.manifest, 'BG output manifest changed');
  assert.equal(output.artifact.status, 'measured', 'BG output artifact is UNKNOWN');
  assert.equal(output.artifact.sourceSha, record.prepared.source.sourceCommit, 'BG output source commit mismatch');
  assert.equal(output.artifact.bundleSha256, output.entry.sha256, 'BG output bundle digest mismatch');
  assert.equal(output.artifact.manifestSha256, output.manifest.sha256, 'BG output manifest digest mismatch');
  assert.equal(output.artifact.evidenceRef, `${output.entry.path}.artifact-${output.entry.sha256}.json`,
    'BG output manifest identity mismatch');
  assert.deepEqual(output.artifact.sourceBlobs, record.prepared.acceptedManifest.members,
    'BG output accepted member census mismatch');
  return output;
}

/** Attach dependencies to the independently invoked tree before its first Node
 * command. Reuse the release helper's donor install mutex and private snapshot.
 * An explicit allowance is shared across phases and requires a finite caller
 * deadline. Neither progress nor a forecast grants more time. Keep the default
 * dependency ceiling when omitted, and reserve the parent's cleanup window.
 * @param {{ donor: string, dest: string, receipt: Awaited<ReturnType<typeof prepareVerifierSource>>, runPhase?: VerifierPhaseRunner, signal?: AbortSignal,
 *   env?: NodeJS.ProcessEnv, maxMs?: number, cutoffEpochMs?: number | null, now?: () => number,
 *   resourceInventory?: ReturnType<typeof verifierResourceInventory> }} options
 */
export async function prepareVerifierDependencies({ donor, dest, receipt, runPhase = async (_phase, operation) => operation(), signal,
  env = process.env, maxMs, cutoffEpochMs, now = Date.now, resourceInventory }) {
  const admission = admitVerifierCommandBudget(null, { env, nowMs: now() });
  if (maxMs !== undefined && (!Number.isSafeInteger(maxMs) || maxMs <= 0 || admission.deadlineEpochMs === null))
    throw new PreviewError('explicit verifier preparation allowance needs positive integer milliseconds and a finite caller task deadline', 2);
  const cutoffs = [admission.childCutoffEpochMs, cutoffEpochMs,
    maxMs === undefined ? null : now() + maxMs].filter(value => value != null);
  const preparationCutoff = cutoffs.length ? Math.min(...cutoffs) : null;
  env = verifierDependencyEnv(env);
  const run = (command, args) => runVerifierDependencyCommand(command, args,
    { cwd: dest, env, signal, maxMs, cutoffEpochMs: preparationCutoff, now, resourceInventory });
  // A retry can retain staging and completed dependency trees. Only this
  // pre-copy check permits staging; the locked helper must adopt it, and
  // subsequent source checks still reject unfinished copies. Runtime assets
  // are seeded only after the committed source itself has been verified.
  await runPhase('deps.source.before', () => verifyVerifierSource(dest, receipt,
    { runtimeArtifacts: true, dependencyStaging: true }));
  const runtimeSetup = join(dest, 'apps/operator/scripts/setup-porcupine-runtime.sh');
  if (existsSync(runtimeSetup)) {
    const modelDonor = join(donor, 'apps/operator/public/porcupine/porcupine_params.pv');
    // The model is gitignored. Copy it through the selected source's own
    // checksum-pinned helper; never link the mutable work-root cache into the
    // immutable verifier snapshot.
    await runPhase('deps.runtime-assets', () => run('bash', [runtimeSetup, '--source', modelDonor]));
  }
  await runPhase('deps.source.after-runtime-assets', () => verifyVerifierSource(dest, receipt,
    { runtimeArtifacts: true, dependencyStaging: true }));
  const copyMode = verifierDependencyCopyMode(donor, dest);
  // Reuse a full immutable generation on the destination filesystem instead
  // of repeatedly copying the mutable donor across devices before tests start.
  // Older frozen refs pin a helper that only has the original locked snapshot.
  // Select its published CLI before invoking it; a supported generation command
  // must still refuse invalid custody rather than retrying through the donor.
  const snapshotHelper = join(dest, 'papercusp-desktop/bin/lib/pinned-deps.sh');
  const generationSnapshotSupported = /^\s*snapshot-generation-locked\s*\)/m.test(await fs.readFile(snapshotHelper, 'utf8'));
  const snapshotSelection = selectVerifierDependencySnapshot(copyMode, generationSnapshotSupported,
    Boolean(env.PAPERCUSP_DEPENDENCY_GENERATION_ROOT));
  await runPhase('deps.snapshot', () => run('bash', [snapshotHelper,
    snapshotSelection.command, realpathSync(donor), realpathSync(dest), copyMode]), { snapshotSelection });
  await runPhase('deps.source.after-snapshot', () => verifyVerifierSource(dest, receipt, { runtimeArtifacts: true }));
  const script = join(dest, 'scripts/source-preview.mjs');
  // The CLI imports workspace TypeScript, including extensionless and directory
  // imports. Resolve its loader from the private snapshot, never ambient options.
  const nodeArgs = ['--import', 'tsx', script];
  await runPhase('deps.inputs', () => run(process.execPath, [...nodeArgs, 'verifier-inputs-check', '--repo', dest,
    '--ref', receipt.sourceCommit, '--inputs', receipt.testedInputs.map(input => input.path).join(',')]));
  // The materialized snapshot has no submodule Git databases. Measure the
  // pinned source tree from its dependency donor, which owns those gitlinks.
  await runPhase('deps.measure', async () => {
    const bytes = (await run(process.execPath, [...nodeArgs, 'verifier-measure', '--repo', realpathSync(donor),
      '--ref', receipt.sourceCommit])).trim();
    if (!/^\d+$/.test(bytes) || Number(bytes) <= 0)
      throw new PreviewError('verifier dependency preflight returned no source size', 2);
  });
  await runPhase('deps.source.after-preflight', () => verifyVerifierSource(dest, receipt, { runtimeArtifacts: true }));
  return runPhase('deps.census', () => captureVerifierCommandDependencies({ dest, receipt, env, run,
    onProgress: progress => runPhase.reportProgress?.('deps.census', progress) }));
}

/** Measure installed bytes, not lockfile intent. Reuse the release helper's
 * product-owned tree population and the source verifier's exact file census.
 * Workspace link targets still need source verification; this receipt does
 * not claim final transformed code or a complete runtime import closure.
 * @param {{ dest: string, receipt: Awaited<ReturnType<typeof prepareVerifierSource>>, env?: NodeJS.ProcessEnv,
 *   onProgress?: (progress: VerifierDependencyProgress) => void }} options
 */
export function captureVerifierDependencies({ dest, receipt, env = process.env, onProgress }) {
  const root = realpathSync(dest);
  const result = spawnSync('bash', [join(root, 'papercusp-desktop/bin/lib/pinned-deps.sh'), 'trees', root],
    { cwd: root, env: verifierDependencyEnv(env), encoding: 'utf8',
      timeout: 60_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0)
    throw new PreviewError(`verifier dependency enumeration failed: ${result.error?.message || result.stderr || result.status}`, 2);
  return captureVerifierDependencyPopulation({ dest, receipt, env, onProgress }, result.stdout);
}

/** Managed commands use the existing process-group/deadline runner for discovery.
 * Keep the synchronous capture API for callers that do not own an async command.
 * Both paths share the exact installed-byte census and population validation.
 * @param {Parameters<typeof captureVerifierDependencies>[0] & {
 *   run: (command: string, args: string[]) => Promise<string> }} options
 */
async function captureVerifierCommandDependencies({ run, ...options }) {
  const root = realpathSync(options.dest);
  const output = await run('bash', [join(root, 'papercusp-desktop/bin/lib/pinned-deps.sh'), 'trees', root]);
  return captureVerifierDependencyPopulation(options, output);
}

/** The verifier's helper must use the same interpreter even under a sanitized
 * compiler PATH or an inherited dependency-generation override.
 * @param {NodeJS.ProcessEnv} env */
function verifierDependencyEnv(env) {
  return { ...env, NODE_OPTIONS: '', NODE_PATH: '', DEPENDENCY_GENERATION_NODE: process.execPath };
}

const VERIFIER_DEPENDENCY_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const VERIFIER_DEPENDENCY_CACHE_MAX_ENTRIES = 64;
/** @type {Map<string, { fingerprint: string, files: Array<{ path: string, kind: string, executable: boolean, sha256: string }>, bytes: number }>} */
const verifierDependencyCensusCache = new Map();
let verifierDependencyCensusCacheBytes = 0;

/** @param {string} cacheKey @param {string} fingerprint */
function readVerifierDependencyCache(cacheKey, fingerprint) {
  const cached = verifierDependencyCensusCache.get(cacheKey);
  if (!cached || cached.fingerprint !== fingerprint) return null;
  verifierDependencyCensusCache.delete(cacheKey);
  verifierDependencyCensusCache.set(cacheKey, cached);
  return cached.files.map(file => ({ ...file }));
}

/** @param {string} cacheKey @param {string} fingerprint
 * @param {Array<{ path: string, kind: string, executable: boolean, sha256: string }>} files */
function rememberVerifierDependencyCache(cacheKey, fingerprint, files) {
  const previous = verifierDependencyCensusCache.get(cacheKey);
  if (previous) {
    verifierDependencyCensusCache.delete(cacheKey);
    verifierDependencyCensusCacheBytes -= previous.bytes;
  }
  const bytes = files.reduce((total, file) => total + Buffer.byteLength(file.path)
    + Buffer.byteLength(file.sha256) + 48, 0);
  if (bytes > VERIFIER_DEPENDENCY_CACHE_MAX_BYTES) return;
  const cachedFiles = files.map(file => Object.freeze({ ...file }));
  verifierDependencyCensusCache.set(cacheKey, { fingerprint, files: cachedFiles, bytes });
  verifierDependencyCensusCacheBytes += bytes;
  while (verifierDependencyCensusCache.size > VERIFIER_DEPENDENCY_CACHE_MAX_ENTRIES
    || verifierDependencyCensusCacheBytes > VERIFIER_DEPENDENCY_CACHE_MAX_BYTES) {
    const oldestKey = verifierDependencyCensusCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = verifierDependencyCensusCache.get(oldestKey);
    verifierDependencyCensusCache.delete(oldestKey);
    if (oldest) verifierDependencyCensusCacheBytes -= oldest.bytes;
  }
}

/** @param {Parameters<typeof captureVerifierDependencies>[0]} options
 * @param {string} output */
function captureVerifierDependencyPopulation({ dest, receipt, env = process.env, onProgress }, output) {
  const root = realpathSync(dest);
  const paths = output.trim().split('\n').filter(Boolean).sort();
  assert.ok(paths.length > 0 && paths.length <= 1000 && new Set(paths).size === paths.length,
    'Verifier dependency tree population missing or duplicated');
  const policyPath = 'apps/operator/bin/release/dependency-generation.sh';
  const policy = { path: policyPath,
    sha256: createHash('sha256').update(readFileSync(join(root, policyPath))).digest('hex') };
  const sourceReceiptSha256 = createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
  const trees = [];
  for (const [treeIndex, path] of paths.entries()) {
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
    { cwd: root, env: verifierDependencyEnv(env), encoding: 'utf8',
      timeout: 120_000, maxBuffer: 128 * 1024 * 1024 });
    if (records.error || records.status !== 0)
      throw new PreviewError(`verifier dependency census failed: ${records.error?.message || records.stderr || records.status}`, 2);
    // The final link-target column is empty for regular files/directories.
    // Trimming whitespace would erase that field from the final record.
    const population = records.stdout.split('\n').filter(Boolean).map(line => line.split('\t'));
    assert.ok(population.every(row => row.length === 10 && ['d', 'f', 'l'].includes(row[1])),
      'Invalid verifier dependency generation records');
    // Source records carry mode, size, mtime, inode, ctime and link target.
    // Include policy and receipt manifests so any of those changes invalidates
    // the byte hashes without trusting size/mtime as content proof.
    const cacheKey = root + '\0' + path;
    const fingerprint = createHash('sha256').update('verifier-dependency-census-v1\0')
      .update(root).update('\0').update(path).update('\0')
      .update(policy.path).update('\0').update(policy.sha256).update('\0')
      .update(sourceReceiptSha256).update('\0').update(records.stdout).digest('hex');
    const cachedFiles = readVerifierDependencyCache(cacheKey, fingerprint);
    const cacheHit = cachedFiles !== null;
    onProgress?.({ completedTrees: treeIndex, totalTrees: paths.length,
      currentTree: path.slice(0, 256), cacheHit });
    const files = cachedFiles ?? verifierSourceFiles(tree, { symlinkRoot: root,
      includedPaths: new Set(population.map(row => row[0])) });
    assert.equal(files.length, population.filter(row => row[1] !== 'd').length,
      'Verifier dependency population changed during census');
    if (!cacheHit) rememberVerifierDependencyCache(cacheKey, fingerprint, files);
    trees.push({ path, files });
  }
  return { schemaVersion: 'verifier-dependencies-v1', scope: 'materialized-dependency-files',
    root, sourceCommit: receipt.sourceCommit, policy,
    sourceReceiptSha256, trees };
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

/** Collect the exact committed source population needed to validate generated
 * workspace executable outputs before allocating the verifier snapshot.
 * @param {string} repo
 * @param {string} commit
 * @param {string} prefix
 * @param {Map<string, { mode: string, repo: string, commit: string, oid: string }>} sourceEntries
 * @param {Array<{ prefix: string, localPath: string, content: string, packageJson: Record<string, unknown> }>} manifests
 */
function collectVerifierWorkspaceBinInputs(repo, commit, prefix, sourceEntries, manifests) {
  const links = [];
  for (const entry of git(repo, ['ls-tree', '-r', '-z', commit]).split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    if (tab < 0) throw new PreviewError('cannot enumerate committed verifier source tree', 2);
    const [mode, type, oid] = entry.slice(0, tab).split(' ');
    const localPath = entry.slice(tab + 1);
    if (mode === '160000' && type === 'commit') {
      links.push({ path: localPath, sha: oid });
    } else if (type === 'blob') {
      const path = prefix ? posixPath.join(prefix, localPath) : localPath;
      sourceEntries.set(path, { mode, repo, commit, oid });
    }
  }

  const grep = spawnSync('git', ['-C', repo, 'grep', '-z', '-l', '-I', '-E',
    '"bin"[[:space:]]*:', commit, '--', ':(top)package.json', ':(glob)**/package.json'],
  { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (grep.error || (grep.status !== 0 && grep.status !== 1))
    throw new PreviewError('cannot inspect committed workspace package manifests for verifier bins: ' +
      (grep.error?.message || grep.stderr || grep.status), 2);
  for (const hit of (grep.stdout || '').split('\0').filter(Boolean)) {
    const colon = hit.indexOf(':');
    const localPath = colon < 0 ? hit : hit.slice(colon + 1);
    if (posixPath.basename(localPath) !== 'package.json') continue;
    const content = git(repo, ['show', commit + ':' + localPath]);
    let packageJson;
    try { packageJson = JSON.parse(content); }
    catch (error) {
      throw new PreviewError('invalid committed workspace package manifest ' +
        (prefix ? prefix + '/' : '') + localPath + ': ' + error.message, 2);
    }
    manifests.push({ prefix, localPath, content, packageJson });
  }

  for (const link of links) {
    const fullPath = prefix ? prefix + '/' + link.path : link.path;
    const submodule = materializedSubmodule(repo, link, fullPath);
    collectVerifierWorkspaceBinInputs(submodule, link.sha, fullPath, sourceEntries, manifests);
  }
}

function committedVerifierPathExists(sourceEntries, path, seen = new Set()) {
  if (seen.has(path)) return false;
  seen.add(path);
  const entry = sourceEntries.get(path);
  if (entry) {
    if (entry.mode !== '120000') return true;
    const target = git(entry.repo, ['cat-file', 'blob', entry.oid]);
    const resolved = posixPath.normalize(posixPath.join(posixPath.dirname(path), target));
    if (posixPath.isAbsolute(target) || resolved === '..' || resolved.startsWith('../')) return false;
    return committedVerifierPathExists(sourceEntries, resolved, seen);
  }
  for (const sourcePath of sourceEntries.keys())
    if (sourcePath.startsWith(path + '/')) return true;
  return false;
}

/** Mirror the pinned-deps workspace-bin requirements without copying anything.
 * The pinned helper remains authoritative for the eventual immutable copy.
 * @param {{ repo: string, commit: string, donor: string }} options
 */
function preflightVerifierWorkspaceBinDonor({ repo, commit, donor }) {
  const sourceEntries = new Map();
  const manifests = [];
  collectVerifierWorkspaceBinInputs(repo, commit, '', sourceEntries, manifests);
  const donorRoot = realpathSync(donor);
  for (const manifest of manifests) {
    const bin = manifest.packageJson.bin;
    const bins = typeof bin === 'string' ? [bin] : Object.values(bin || {});
    const packageDir = posixPath.dirname(manifest.localPath);
    const packageRoot = packageDir === '.' ? '' : packageDir;
    const globalPackageRoot = manifest.prefix
      ? (packageRoot ? manifest.prefix + '/' + packageRoot : manifest.prefix)
      : packageRoot;
    const manifestPath = manifest.prefix ? manifest.prefix + '/' + manifest.localPath : manifest.localPath;
    for (const target of bins) {
      if (typeof target !== 'string' || !/^(\.\/)?dist\//.test(target)) continue;
      const localTarget = posixPath.normalize(posixPath.join(packageDir, target));
      if (posixPath.isAbsolute(localTarget) ||
          (packageRoot && localTarget !== packageRoot && !localTarget.startsWith(packageRoot + '/')) ||
          (!packageRoot && (localTarget === '..' || localTarget.startsWith('../'))))
        throw new PreviewError('escaping-workspace-bin:' + manifestPath, 2);
      const targetPath = manifest.prefix ? manifest.prefix + '/' + localTarget : localTarget;
      if (committedVerifierPathExists(sourceEntries, targetPath)) continue;
      const outputPath = posixPath.join(globalPackageRoot, 'dist');
      if (committedVerifierPathExists(sourceEntries, outputPath))
        throw new PreviewError('recorded-workspace-bin-output:' + outputPath, 2);

      const donorManifest = join(donorRoot, ...manifestPath.split('/'));
      let donorManifestBytes;
      try { donorManifestBytes = readFileSync(donorManifest); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        throw new PreviewError('workspace-bin-manifest-missing:' + manifestPath, 2);
      }
      if (!donorManifestBytes.equals(Buffer.from(manifest.content)))
        throw new PreviewError('workspace-bin-manifest-mismatch:' + manifestPath, 2);
      const donorTarget = join(donorRoot, ...targetPath.split('/'));
      if (!existsSync(donorTarget))
        throw new PreviewError('missing-workspace-bin-output:' + manifestPath, 2);
      const donorOutput = join(donorRoot, ...outputPath.split('/'));
      const outputStat = lstatSync(donorOutput, { throwIfNoEntry: false });
      const physicalOutput = outputStat?.isDirectory() ? realpathSync(donorOutput) : '';
      const outputRelative = physicalOutput ? relative(donorRoot, physicalOutput) : '';
      if (!outputStat?.isDirectory() || outputRelative === '..' ||
          outputRelative.startsWith('..' + sep) || isAbsolute(outputRelative))
        throw new PreviewError('unsafe-workspace-bin-output:' + outputPath, 2);
    }
  }
}

/** Freeze source and dependencies before invoking a command that allocates fixtures.
 * The receipt survives outside the owned tree; only this invocation's tree is removed.
 * @param {{ repo: string, ref: string, receiptPath: string, inputs?: string[], inputsFile?: string, tauriInputs?: boolean, command: string[], env?: NodeJS.ProcessEnv, budgetFrom?: string, childEstimateMs?: number, preparationMaxMs?: number, prepareChildEnv?: (context: { sourceRoot: string }) => Promise<NodeJS.ProcessEnv | void> | NodeJS.ProcessEnv | void, releaseParentPrivatePg?: boolean, requestParentPgReleaseImpl?: (token: string) => Promise<unknown>,
 *   signal?: AbortSignal, clock?: { now: () => number, setTimeout: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>, clearTimeout: (timer: ReturnType<typeof setTimeout>) => void } }} options
 * @returns {Promise<number>}
 */
export async function runVerifierCommand({ repo, ref, receiptPath, inputs = [], inputsFile, tauriInputs = false, command, env = process.env, budgetFrom, childEstimateMs = 0, preparationMaxMs, prepareChildEnv = async () => ({}),
  releaseParentPrivatePg = false, requestParentPgReleaseImpl = requestPrivateTestPgRelease, signal,
  clock = { now: Date.now, setTimeout, clearTimeout } }) {
  if (signal?.aborted) throw new PreviewError('verifier command canceled before launch', 143);
  if (!ref?.trim() || !receiptPath || !command?.length || !command[0])
    throw new PreviewError('verifier command needs an explicit ref, external receipt and command', 2);
  if (!Number.isSafeInteger(childEstimateMs) || childEstimateMs < 0)
    throw new PreviewError('verifier child estimate must be a nonnegative integer', 2);
  const sourceRepo = realpathSync(repo);
  env = verifierCommandAdmissionEnv({ repo: sourceRepo, env });
  const parentPgReleaseToken = env[PRIVATE_TEST_PG_RELEASE_TOKEN_ENV];
  if (releaseParentPrivatePg && !parentPgReleaseToken)
    throw new PreviewError('parent private test-PG release requires the wrapper-issued token', 2);
  const parentPgReleaseEnabled = releaseParentPrivatePg === true && Boolean(parentPgReleaseToken);
  if (preparationMaxMs !== undefined && (!Number.isSafeInteger(preparationMaxMs) || preparationMaxMs <= 0 || readTaskDeadlineEpochMs(env) === null))
    throw new PreviewError('explicit verifier preparation allowance needs positive integer milliseconds and a finite caller task deadline', 2);
  const sourceCommit = resolveCommit(sourceRepo, ref);
  const explicitGeneration = Boolean(env.PAPERCUSP_DEPENDENCY_GENERATION_ROOT);
  const donor = explicitGeneration ? sourceRepo : committedWorkRootDependencyDonor(sourceRepo);
  const runtimeSetupPath = 'apps/operator/scripts/setup-porcupine-runtime.sh';
  if (git(sourceRepo, ['ls-tree', sourceCommit, '--', runtimeSetupPath]).trim()) {
    // Ignored runtime assets are not covered by node/workspace generation custody.
    // Use the selected commit's checksum pin before allocating the source tree;
    // the eventual snapshot still copies and rechecks the donor bytes.
    const runtimeSetup = git(sourceRepo, ['show', sourceCommit + ':' + runtimeSetupPath]);
    const modelDonor = join(donor, 'apps/operator/public/porcupine/porcupine_params.pv');
    const check = spawnSync('bash', ['-c', runtimeSetup, join(sourceRepo, runtimeSetupPath),
      '--check-source', modelDonor], { cwd: sourceRepo, env: verifierDependencyEnv(env),
      encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
    if (check.error || check.status !== 0)
      throw new PreviewError('verifier runtime asset preflight failed: ' +
        (check.error?.message || check.stderr || check.status), 2);
  }
  // Never allocate below a source donor: even ignored scratch is part of an
  // immutable source census. Reuse the external root the task reconciler knows.
  let scratch = await fs.realpath(tmpdir());
  if (process.platform === 'linux') {
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
  if (isInside(donor, scratch) || isInside(sourceRepo, scratch))
    throw new PreviewError('verifier command scratch must be outside the source and dependency donor', 2);
  const copyMode = verifierDependencyCopyMode(donor, scratch);
  const helperPath = 'papercusp-desktop/bin/lib/pinned-deps.sh';
  const helperObject = committedInputObject(sourceRepo, sourceCommit, helperPath, new Map(), true);
  const helperSource = helperObject ? git(helperObject.repo, ['cat-file', 'blob', helperObject.blob]) : '';
  const snapshotSelection = selectVerifierDependencySnapshot(copyMode,
    /^\s*snapshot-generation-locked\s*\)/m.test(helperSource), explicitGeneration);
  // Automatic cross-device selection consumes the same immutable closure as an
  // explicit generation. Select its contract from the requested commit, then
  // validate custody against that frozen source before copying dependencies.
  if (snapshotSelection.command === 'snapshot-generation-locked') {
    if (!/^\s*preflight-generation\s*\)/m.test(helperSource))
      throw new PreviewError('selected source does not support immutable verifier generations', 2);
  } else preflightVerifierWorkspaceBinDonor({ repo: sourceRepo, commit: sourceCommit, donor });
  const taskReceiptPath = `${resolve(receiptPath)}.task.json`;
  const cancellation = new AbortController();
  let cancellationSignal;
  const cancel = signal => {
    cancellationSignal ??= signal;
    cancellation.abort();
  };
  const onInt = () => cancel('SIGINT'), onTerm = () => cancel('SIGTERM'), onHup = () => cancel('SIGHUP');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm); process.on('SIGHUP', onHup);
  signal?.addEventListener('abort', onTerm, { once: true });
  if (signal?.aborted) onTerm();
  let owned;
  try { owned = await fs.mkdtemp(join(scratch, 'verifier-command-')); }
  catch (error) {
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); process.off('SIGHUP', onHup);
    signal?.removeEventListener('abort', onTerm);
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
  let finalizationFailure;
  let budget;
  let commandExitCode = null;
  let phaseArchivePath;
  let taskEvidenceRoot;
  let taskEvidenceManifestPath;
  let resourceInventory;
  let inventoryCustody;
  let inventoryTerminal;
  const admitBudget = (estimate, preparation = false) => {
    const admission = admitVerifierCommandBudget(estimate, { env, preparation, nowMs: clock.now() });
    budget = { deadlineEpochMs: admission.deadlineEpochMs, cleanupReserveMs: admission.cleanupReserveMs,
      childCutoffEpochMs: admission.childCutoffEpochMs, admittedAtMs: clock.now(),
      cutoffTriggeredAtMs: null, childExitVerifiedAtMs: null };
    return admission;
  };
  try {
    assertOutsideArchive(owned, resolve(receiptPath));
    ownership = writeVerifierTaskReceipt(owned, sourceRepo, env, taskReceiptPath);
    const originalDeadline = readTaskDeadlineEpochMs(env);
    if (originalDeadline !== null) {
      inventoryCustody = { ownership, sourceCommit };
      resourceInventory = verifierResourceInventory({ path: `${receiptPath}.resources.jsonl`,
        owner: ownership.taskId ?? ownership.processIdentity, deadlineEpochMs: originalDeadline,
        custody: inventoryCustody, now: clock.now });
      resourceInventory.record({ id: 'candidate-root', kind: 'root', path: owned });
      resourceInventory.record({ id: 'source-root', kind: 'root', path: root });
    }
    const tracedPhase = verifierPhaseRunner(`${resolve(receiptPath)}.phases.jsonl`, env,
      `${receiptPath}.child.json`);
    phaseArchivePath = tracedPhase.archivePath;
    if (ownership.taskId) {
      const taskEvidenceTaskRoot = join(dirname(phaseArchivePath), `verifier-task-${ownership.taskId}`);
      mkdirSync(taskEvidenceTaskRoot, { recursive: true, mode: 0o700 });
      const taskEvidenceStat = lstatSync(taskEvidenceTaskRoot);
      assert.ok(taskEvidenceStat.isDirectory() && !taskEvidenceStat.isSymbolicLink(),
        'Verifier task evidence directory is not private storage');
      assert.equal(taskEvidenceStat.mode & 0o077, 0, 'Verifier task evidence directory must be private');
      const runId = createHash('sha256').update(resolve(receiptPath)).digest('hex');
      taskEvidenceRoot = join(taskEvidenceTaskRoot, runId);
      mkdirSync(taskEvidenceRoot, { mode: 0o700 });
      const runEvidenceStat = lstatSync(taskEvidenceRoot);
      assert.ok(runEvidenceStat.isDirectory() && !runEvidenceStat.isSymbolicLink(),
        'Verifier task run-evidence directory is not private storage');
      assert.equal(runEvidenceStat.mode & 0o077, 0, 'Verifier task run-evidence directory must be private');
      taskEvidenceManifestPath = join(taskEvidenceRoot, 'manifest.json');
    }
    process.stderr.write(`VERIFIER_PHASE_ARCHIVE ${JSON.stringify({
      path: `${resolve(receiptPath)}.phases.jsonl`, archivePath: tracedPhase.archivePath,
    })}\n`);
    const measurements = {};
    const executePhase = async (phase, operation, metadata) => {
      // Synchronous archive/census work delays JS signal delivery. Yield before
      // admitting the next phase, so a pending cancellation cannot start tests.
      const mustFinishAfterCancellation = phase === 'cleanup' || phase === 'private-pg.release';
      if (!mustFinishAfterCancellation) {
        await new Promise(resolve => setImmediate(resolve));
        checkCancellation();
      }
      const before = performance.now();
      const result = await tracedPhase(phase, async () => {
        const result = await operation();
        if (phase === 'deps.snapshot') {
          const snapshotReceipt = join(root, '.papercusp-pinned-deps');
          // Retain the ORIGINAL selected generation before census can fail and
          // owned-tree cleanup removes its only custody record. Older helpers
          // may omit it; absence must stay absence rather than reconstruction.
          if (existsSync(snapshotReceipt)) {
            const identity = readBgIndependentOutputIdentity(snapshotReceipt);
            const bytes = await fs.readFile(snapshotReceipt);
            assert.equal(createHash('sha256').update(bytes).digest('hex'), identity.sha256,
              'Verifier dependency snapshot receipt changed while retaining it');
            await fs.writeFile(`${receiptPath}.snapshot.txt`, bytes, { flag: 'wx', mode: 0o600 });
          }
        }
        return result;
      }, metadata);
      if (resourceInventory) {
        const retained = { 'receipt.write': receiptPath, 'deps.snapshot': `${receiptPath}.snapshot.txt`,
          'deps.receipt.write': `${receiptPath}.dependencies.json` }[phase];
        if (retained && existsSync(retained)) resourceInventory.record({ id: phase, kind: 'binding',
          path: resolve(retained), retain: 'original source/dependency evidence' });
      }
      measurements[phase] = Math.ceil(performance.now() - before);
      if (!mustFinishAfterCancellation) {
        await new Promise(resolve => setImmediate(resolve));
        checkCancellation();
      }
      return result;
    };
    runPhase = Object.assign(executePhase, {
      reportProgress: (phase, progress) => tracedPhase.reportProgress?.(phase, progress),
    });
    let previousMeasurements;
    await runPhase('source.admission', () => {
      previousMeasurements = budgetFrom ? readVerifierPhaseMeasurements(budgetFrom) : null;
      const estimate = previousMeasurements
        ? estimateVerifierCommandBudget(previousMeasurements, childEstimateMs,
          { parentPgRelease: parentPgReleaseEnabled })
        : null;
      return admitBudget(estimate, true);
    });
    const receipt = await runPhase('source.freeze', () => prepareVerifierSource({ repo: sourceRepo, ref: sourceCommit, dest: root,
      inputs, inputsFile, tauriInputs, gitCheckout: true }));
    await runPhase('receipt.write', () => fs.writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o600 }));
    if (snapshotSelection.command === 'snapshot-generation-locked') {
      await runPhase('deps.preflight', () => {
        const check = spawnSync('bash', [join(root, helperPath), 'preflight-generation', donor, root],
          { env: verifierDependencyEnv(env), encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
        if (check.error || check.status !== 0)
          throw new PreviewError('verifier generation preflight failed: ' +
            (check.error?.message || check.stderr || check.status), 2);
      });
    }
    const dependencies = await prepareVerifierDependencies({ donor, dest: root, receipt, runPhase,
      signal: cancellation.signal, env, maxMs: preparationMaxMs, cutoffEpochMs: budget.childCutoffEpochMs, now: clock.now, resourceInventory });
    await runPhase('deps.receipt.write', () => fs.writeFile(`${receiptPath}.dependencies.json`,
      `${JSON.stringify(dependencies)}\n`, { flag: 'wx', mode: 0o600 }));
    const childEstimate = estimateVerifierCommandBudget({ ...previousMeasurements, ...measurements }, childEstimateMs,
      { parentPgRelease: parentPgReleaseEnabled });
    await runPhase('child.admission', () => admitBudget(childEstimate));
    const childEnv = await runPhase('child.preflight', () => verifierSourceChildEnv({ root, receiptPath,
        env: { ...env, PAPERCUSP_REPO_DIR: root, NODE_OPTIONS: '', NODE_PATH: '',
          VERIFY_TAURI_SOURCE_INPUTS: receipt.testedInputs.map(input => input.path).join(',') } }));
    // Resource setup that depends on a ready command environment (for example
    // starting the parent's private PG) happens only after committed source and
    // dependency-generation preparation have succeeded. A missing generation
    // therefore cannot allocate PG and then fail inside this verifier.
    const preparedChildEnv = await runPhase('child.environment', async () =>
      (await prepareChildEnv({ sourceRoot: root })) ?? {});
    const finalChildEnv = { ...childEnv, ...preparedChildEnv };
    let exitCode;
    let childRunError;
    try { exitCode = await runPhase('child.run', async () => {
      // Preflight can consume the admitted clock. Check again at the actual
      // spawn boundary, then keep the absolute cutoff until the WHOLE group exits.
      admitBudget(childEstimate);
      const child = spawn(command[0], command.slice(1), { cwd: root, env: finalChildEnv,
        detached: process.platform !== 'win32', stdio: ['inherit', 'pipe', 'pipe'] });
      const lifetime = processGroupLifetime(child, message => process.stderr.write(`${message}\n`));
      let diagnostics, captureError;
      const outcome = { pid: child.pid ?? null, exitCode: null, signal: null, error: null };
      const collect = stream => chunk => {
        if (captureError) return;
        try { diagnostics.collect(stream, chunk); }
        catch (error) { captureError = error; rejectStopped(error); }
      };
      let termination;
      let timer;
      let finished = false;
      let rejectStopped;
      const stopped = new Promise((_, reject) => { rejectStopped = reject; });
      stopped.catch(() => {});
      const cutoffError = () => new PreviewError(`VERIFIER_CHILD_DEADLINE_CUTOFF deadlineEpochMs=${budget.deadlineEpochMs} ` +
        `cleanupReserveMs=${budget.cleanupReserveMs} childCutoffEpochMs=${budget.childCutoffEpochMs}`, 2);
      const onAbort = () => {
        if (termination) return;
        termination = lifetime.terminate({ graceMs: 1_000, killWaitMs: 5_000 });
        // An unverified group may never close its pipes. Surface the failed fence
        // without waiting forever for close, and retain its tree for reconciliation.
        termination.then(() => {
          budget.childExitVerifiedAtMs = clock.now();
          rejectStopped(budget.cutoffTriggeredAtMs !== null ? cutoffError()
            : new PreviewError(`verifier command canceled by ${cancellationSignal}`, 2));
        }, error => {
          error.retainVerifierTree = true;
          rejectStopped(error);
        });
      };
      const armCutoff = () => {
        if (finished || budget.childCutoffEpochMs === null || cancellation.signal.aborted) return;
        const remainingMs = budget.childCutoffEpochMs - clock.now();
        if (remainingMs > 0) {
          // Long deadlines must not overflow Node's signed 32-bit timer delay.
          timer = clock.setTimeout(armCutoff, Math.min(remainingMs, 2_147_483_647));
        } else {
          budget.cutoffTriggeredAtMs = clock.now();
          cancellation.abort();
        }
      };
      let onError, onClose;
      try {
        if (resourceInventory) {
          const identity = readProcessIdentity(child.pid);
          assert.ok(identity, 'Verifier child original process identity unavailable');
          resourceInventory.record({ id: `process:${child.pid}:${identity}`, kind: 'process',
            pid: child.pid, processIdentity: identity, processGroup: child.pid });
        }
        diagnostics = verifierChildDiagnostics(receiptPath);
        child.stdout.on('data', collect('stdout'));
        child.stderr.on('data', collect('stderr'));
        /** @type {Promise<number>} */
        const closed = new Promise((done, reject) => {
          onError = reject;
          onClose = (code, signal) => {
            outcome.exitCode = code;
            outcome.signal = signal;
            done(code ?? (128 + (constants.signals[signal] || 0)));
          };
          child.once('error', onError);
          child.once('close', onClose);
        });
        cancellation.signal.addEventListener('abort', onAbort, { once: true });
        if (cancellation.signal.aborted) onAbort();
        armCutoff();
        const code = await Promise.race([closed, stopped]);
        await (termination ?? lifetime.waitForExit({ timeoutMs: 60_000 }));
        if (termination) await termination;
        budget.childExitVerifiedAtMs = clock.now();
        if (budget.cutoffTriggeredAtMs !== null) throw cutoffError();
        if (captureError) throw captureError;
        commandExitCode = code;
        return code;
      } catch (error) {
        outcome.error = String(error?.message ?? error).slice(0, 2000);
        try { await (termination ?? lifetime.terminate({ graceMs: 1_000, killWaitMs: 5_000 })); }
        catch (exitError) {
          throw new AggregateError([error, exitError], `${error.message}; ${exitError.message}`,
            { cause: Object.assign(exitError, { retainVerifierTree: true }) });
        }
        budget.childExitVerifiedAtMs = clock.now();
        throw error;
      } finally {
        finished = true;
        if (timer !== undefined) clock.clearTimeout(timer);
        cancellation.signal.removeEventListener('abort', onAbort);
        if (onError) child.removeListener('error', onError);
        if (onClose) child.removeListener('close', onClose);
        diagnostics?.finish(outcome);
      }
    }); } catch (error) { childRunError = error; }
    let privatePgReleaseError;
    if (parentPgReleaseEnabled && budget && budget.childExitVerifiedAtMs !== null) {
      try {
        await runPhase('private-pg.release', () => requestParentPgReleaseImpl(parentPgReleaseToken));
      } catch (error) { privatePgReleaseError = error; }
    }
    if (childRunError && privatePgReleaseError) {
      const message = error => String(error?.message ?? error);
      throw new AggregateError([childRunError, privatePgReleaseError],
        `verifier child failed: ${message(childRunError)}; parent private PG release failed: ${message(privatePgReleaseError)}`,
        { cause: childRunError });
    }
    if (childRunError) throw childRunError;
    if (privatePgReleaseError) throw privatePgReleaseError;
    await runPhase('deps.postverify', async () => {
      const after = await captureVerifierCommandDependencies({ dest: root, receipt, env,
        run: (command, args) => runVerifierDependencyCommand(command, args,
          { cwd: root, env: verifierDependencyEnv(env), signal: cancellation.signal,
            cutoffEpochMs: budget.childCutoffEpochMs, now: clock.now, resourceInventory }),
        onProgress: progress => runPhase.reportProgress?.('deps.postverify', progress) });
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
    const inventoryOutcome = cancellationSignal ? 'cancellation' : budget?.cutoffTriggeredAtMs != null ? 'timeout'
      : failure || (commandExitCode !== null && commandExitCode !== 0) ? 'failure' : 'success';
    try {
      let inventoryHasWriters = false;
      if (resourceInventory) {
        inventoryTerminal = await resourceInventory.reconcile({ outcome: inventoryOutcome,
          custody: { ownership: JSON.parse(readFileSync(taskReceiptPath, 'utf8')), sourceCommit } });
        inventoryHasWriters = inventoryTerminal.observations.some(row => row.pid !== undefined && row.state !== 'exited');
      }
      // An unverified exit is not permission to race a live writer. The task's
      // retained ownership receipt lets the existing reconciler clean it later.
      if (inventoryHasWriters || failure?.retainVerifierTree || failure?.cause?.retainVerifierTree) {
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
          finalizationFailure = cleanupError;
          if (failure) {
            finalizationFailure = new AggregateError([failure, cleanupError],
              `${failure.message}; verifier cleanup failed: ${cleanupError.message}`);
            throw finalizationFailure;
          }
          throw cleanupError;
        }
      }
      if (resourceInventory) {
        inventoryTerminal = await resourceInventory.reconcile({ outcome: inventoryOutcome, custody: inventoryCustody });
        if (!failure && inventoryOutcome === 'success' && inventoryTerminal.status !== 'completed')
          throw new PreviewError(`Verifier teardown unqualified: ${JSON.stringify(inventoryTerminal)}`, 2);
      }
    } catch (cleanupError) {
      finalizationFailure = failure && failure !== cleanupError
        ? new AggregateError([failure, cleanupError], `${failure.message}; verifier finalization failed: ${cleanupError.message}`)
        : cleanupError;
      throw finalizationFailure;
    } finally {
      try {
        if (ownership) {
          const next = `${taskReceiptPath}.${process.pid}.tmp`;
          try {
            await fs.writeFile(next, `${JSON.stringify({ ...ownership, cleanup,
              resourceInventory: resourceInventory ? { path: `${receiptPath}.resources.jsonl`,
                history: resourceInventory.checkpoint(), terminal: inventoryTerminal }
                : { status: 'unknown', reason: 'original finite task deadline unavailable' },
              ...(budget ? { budget } : {}),
              ...(cancellationSignal ? { cancellationSignal } : {}),
              ...(taskEvidenceManifestPath ? { evidenceManifestPath: taskEvidenceManifestPath } : {}) })}\n`,
            { flag: 'wx', mode: 0o600 });
            await fs.rename(next, taskReceiptPath);
          } finally { await fs.rm(next, { force: true }); }
        }
        if (taskEvidenceRoot && ownership && phaseArchivePath) {
          try {
            const retainedManifestPath = archiveVerifierTaskEvidence({ evidenceRoot: taskEvidenceRoot, taskId: ownership.taskId,
              sourceCommit, receiptPath, taskReceiptPath, phaseArchivePath, cleanup,
              childExitCode: commandExitCode, error: failure ?? finalizationFailure });
            process.stderr.write(`VERIFIER_TASK_EVIDENCE ${JSON.stringify({
              taskId: ownership.taskId, manifestPath: retainedManifestPath,
            })}\n`);
          } catch (evidenceError) {
            const priorError = failure ?? finalizationFailure;
            if (priorError) throw new AggregateError([priorError, evidenceError],
              `${priorError.message}; verifier task evidence retention failed: ${evidenceError.message}`,
              { cause: priorError });
            throw evidenceError;
          }
        }
      } finally {
        process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); process.off('SIGHUP', onHup);
        signal?.removeEventListener('abort', onTerm);
      }
    }
    checkCancellation();
  }
}

/** Fail closed on absent/changed provenance or any modified/extra/missing source byte.
 * @param {string} dest
 * @param {Awaited<ReturnType<typeof prepareVerifierSource>>} expected
 * @param {{ runtimeArtifacts?: boolean, dependencyStaging?: boolean }} [options] Source-only runtime mode permits
 * named untracked build outputs and materialized dependency directories, not source edits.
 * dependencyStaging is reserved for the pre-copy preparation check; it never attests dependency bytes.
 */
export async function verifyVerifierSource(dest, expected, options = {}) {
  return verifyVerifierSourceSync(dest, expected, options);
}

/** Synchronous boundary for hooks such as Playwright onBegin, whose return
 * value is not awaited. Uses the same source population and receipt checks.
 * @param {string} dest
 * @param {Awaited<ReturnType<typeof prepareVerifierSource>>} expected
 * @param {{ runtimeArtifacts?: boolean, dependencyStaging?: boolean }} [options]
 * dependencyStaging is reserved for the pre-copy preparation check.
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
  const childEnv = { ...env, VERIFY_TAURI_SOURCE_RECEIPT: receipt, VERIFY_TAURI_SOURCE_REF: expected.sourceCommit };
  delete childEnv[PRIVATE_TEST_PG_RELEASE_TOKEN_ENV];
  return childEnv;
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
      if (row.snapshotSelection !== undefined) {
        assert.ok(row.phase === 'deps.snapshot', 'Snapshot selection belongs to the snapshot phase');
        assertVerifierSnapshotSelection(row.snapshotSelection);
      }
      started.add(row.phase);
    } else if (row.event === 'progress') {
      const progress = row.progress;
      assert.ok(started.has(row.phase) && ['deps.census', 'deps.postverify'].includes(row.phase),
        'Invalid verifier phase progress receipt');
      assertVerifierDependencyProgress(progress);
    } else {
      assert.ok(started.delete(row.phase) && ['completed', 'failed'].includes(row.event),
        'Verifier phase terminal record lacks a start');
      if (row.event === 'completed') {
        assert.ok(Number.isSafeInteger(row.durationMs) && row.durationMs >= 0,
          'Invalid verifier phase duration');
        measurements[row.phase] = Math.max(measurements[row.phase] ?? 0, row.durationMs);
      }
    }
  }
  return measurements;
}

/** Reserve both complete final censuses and cleanup, using this run's observations or an
 * explicitly selected earlier phase receipt. Estimates are prognoses, not guarantees;
 * an omitted child estimate remains explicitly unknown. No source/dependency scope changes.
 * `totalMs` is work remaining at source admission, not a caller timeout. Use
 * `requiredTimeoutMs` when launching: startup already spends the absolute clock.
 * Reserve at least 30s, or 125% of an explicitly measured launch delay. This is
 * a forecast; admission still checks the actual remaining clock independently.
 * @param {Record<string, number>} measurements @param {number} [childEstimateMs]
 * @param {{ observedLaunchMs?: number, maxTimeoutMs?: number, parentPgRelease?: boolean,
 *   bgRecipe?: { invocationCount: number, completedPhases?: string[],
 *     activePhase?: { phase: string, elapsedMs: number } } }} [options]
 */
export function estimateVerifierCommandBudget(measurements, childEstimateMs = 0,
  { observedLaunchMs, maxTimeoutMs, parentPgRelease = false, bgRecipe } = {}) {
  for (const [phase, duration] of Object.entries(measurements))
    assert.ok(Number.isSafeInteger(duration) && duration >= 0, `Invalid verifier phase duration: ${phase}`);
  assert.ok(Number.isSafeInteger(childEstimateMs) && childEstimateMs >= 0, 'Invalid verifier child estimate');
  assert.ok(observedLaunchMs === undefined || Number.isSafeInteger(observedLaunchMs) && observedLaunchMs >= 0,
    'Invalid verifier launch observation');
  assert.ok(maxTimeoutMs === undefined || Number.isSafeInteger(maxTimeoutMs) && maxTimeoutMs > 0,
    'Invalid verifier caller timeout ceiling');
  let recipePhases;
  if (bgRecipe) {
    const { invocationCount, completedPhases = [], activePhase } = bgRecipe;
    assert.ok(Number.isSafeInteger(invocationCount) && invocationCount > 0 && invocationCount <= 1000,
      'Invalid BG recipe invocation count');
    for (const phase of ['bg.compiler.before-build', 'bg.compiler.custody', 'bg.compiler.build', 'bg.compiler.verify'])
      assert.ok(Object.hasOwn(measurements, phase), `Verifier budget requires completed phase: ${phase}`);
    const compilerMs = Math.max(1,
      Object.entries(measurements).filter(([phase]) => phase.startsWith('bg.compiler.'))
        .reduce((total, [, duration]) => total + duration, 0),
      ...Object.entries(measurements).filter(([phase]) => /^bg\.recipe\.compiler\.\d+$/.test(phase))
        .map(([, duration]) => duration));
    // A completed compiler includes all three fresh censuses and consumed-byte
    // checks. Use that whole cost for EACH tail census until a slower tail is
    // observed. Counts follow the maintained call graph: logical qualification
    // does output(2), artifact(2), logical(3); publication checks logical twice.
    // These are explicit conservative proxies, never completed tail evidence.
    /** @type {[string, number][]} */
    const plan = [['bg.recipe.validate', 1], ['bg.recipe.begin', 3],
      ...Array.from({ length: invocationCount }, (_, i) => /** @type {[string, number]} */ ([`bg.recipe.compiler.${i}`, 1])),
      ['bg.recipe.assets', 2], ['bg.recipe.output', 2], ['bg.recipe.logical', 7],
      ['bg.recipe.publish', 6], ['bg.recipe.verify', 3]];
    assert.ok(new Set(completedPhases).size === completedPhases.length &&
      completedPhases.every((phase, index) => phase === plan[index]?.[0]),
    'BG recipe budget completion order changed');
    if (activePhase) assert.ok(activePhase.phase === plan[completedPhases.length]?.[0] &&
      Number.isSafeInteger(activePhase.elapsedMs) && activePhase.elapsedMs >= 0,
    'Invalid BG recipe active phase');
    recipePhases = plan.slice(completedPhases.length).map(([phase, passes]) => {
      const estimateMs = Math.max(measurements[phase] ?? 0, compilerMs * Number(passes));
      return { phase: String(phase), estimateMs: Math.max(0,
        estimateMs - (activePhase?.phase === phase ? activePhase.elapsedMs : 0)) };
    });
  } else {
    for (const phase of VERIFIER_PREPARATION_PHASES)
      assert.ok(Object.hasOwn(measurements, phase), `Verifier budget requires completed phase: ${phase}`);
  }
  const preparationMs = bgRecipe ? 0 : VERIFIER_PREPARATION_PHASES.reduce((total, phase) => total + measurements[phase], 0);
  const sourceCheckMs = Math.max(...['deps.source.before', 'deps.source.after-snapshot',
    'deps.source.after-preflight', 'child.preflight', 'source.postverify'].map(phase => measurements[phase] ?? 0));
  const dependencyCheckMs = Math.max(measurements['deps.census'] ?? 0, measurements['deps.postverify'] ?? 0);
  // With no completed cleanup receipt, reserve at least the observed snapshot/freezing
  // work: deletion must still walk the whole population. This is a conservative proxy.
  const cleanupMs = Math.max(120_000, measurements.cleanup ?? 0, measurements['source.freeze'] ?? 0, measurements['deps.snapshot'] ?? 0);
  const privatePgReleaseMs = parentPgRelease ? 10_000 : 0;
  const remainingMs = (recipePhases ? recipePhases.reduce((total, phase) => total + phase.estimateMs, 0)
    : sourceCheckMs * 2 + dependencyCheckMs + childEstimateMs) + cleanupMs + privatePgReleaseMs;
  const remainingBudgetMs = Math.ceil(remainingMs * 1.25);
  // Preparation consumes its margin before child admission reforecasts the
  // remaining work. Reserve that child margin at launch too: a slower snapshot
  // both spends preparation time and raises the protected cleanup reserve.
  const totalMs = Math.ceil((preparationMs + remainingBudgetMs) * 1.25);
  const launchReserveMs = Math.max(30_000, Math.ceil((observedLaunchMs ?? 0) * 1.25));
  // The launcher publishes whole seconds and admission requires strictly more
  // than the forecast. Retain that strict boundary even on exact seconds.
  const requiredTimeoutMs = (Math.floor((totalMs + launchReserveMs) / 1_000) + 1) * 1_000;
  assert.ok(Number.isSafeInteger(requiredTimeoutMs), 'Invalid verifier launch budget');
  if (maxTimeoutMs !== undefined && requiredTimeoutMs > maxTimeoutMs)
    throw new PreviewError(`VERIFIER_LAUNCH_BUDGET_REFUSAL requiredTimeoutMs=${requiredTimeoutMs} ` +
      `maxTimeoutMs=${maxTimeoutMs} workEstimateMs=${totalMs} launchReserveMs=${launchReserveMs} — ` +
      'the caller ceiling cannot fit the work forecast plus launch reserve; do not start providers.', 2);
  return { preparationMs, sourceCheckMs, dependencyCheckMs, cleanupMs, childEstimateMs,
    unknownChild: !bgRecipe && childEstimateMs === 0, remainingMs: remainingBudgetMs,
    totalMs, observedLaunchMs: observedLaunchMs ?? null, launchReserveMs, requiredTimeoutMs,
    ...(recipePhases ? { recipePhases } : {}) };
}

/** Reuse the launcher's absolute deadline and the scheduler's attributable refusal. */
export function admitVerifierCommandBudget(estimate, { env = process.env, nowMs = Date.now(), preparation = false } = {}) {
  const privatePgReleaseMs = env[PRIVATE_TEST_PG_RELEASE_TOKEN_ENV] ? 10_000 : 0;
  const cleanupReserveMs = Math.max(120_000, estimate?.cleanupMs ?? 0) + privatePgReleaseMs;
  const knownEstimateMs = Math.max(cleanupReserveMs, estimate ? (preparation ? estimate.totalMs : estimate.remainingMs) : 0);
  try {
    return { ...admitTaskDeadline({ env, nowMs, cleanupReserveMs, knownEstimateMs,
      knownTasks: estimate ? (estimate.recipePhases?.length ?? VERIFIER_PREPARATION_PHASES.length) : 0,
      unknownTasks: estimate?.unknownChild === false ? 0 : 1 }), estimate };
  } catch (error) {
    throw new PreviewError(error.message, 2);
  }
}

/**
 * Copy the managed verifier's receipts into the existing checkpoint-log store
 * before the command can exit. Terminal wakes may be consumed hours later, after
 * their caller's /tmp files have been removed. The task id names the bundle; the
 * manifest is written last so readers never mistake a partial copy for a verdict.
 * @param {{ evidenceRoot: string, taskId: string, sourceCommit: string, receiptPath: string,
 *   taskReceiptPath: string, phaseArchivePath: string, cleanup: string,
 *   childExitCode: number|null, error?: unknown }} args
 * @returns {string}
 */
function archiveVerifierTaskEvidence({ evidenceRoot, taskId, sourceCommit, receiptPath, taskReceiptPath,
  phaseArchivePath, cleanup, childExitCode, error }) {
  const candidates = [
    ['source.json', receiptPath],
    ['snapshot.txt', `${receiptPath}.snapshot.txt`],
    ['dependencies.json', `${receiptPath}.dependencies.json`],
    ['dependencies-after.json', `${receiptPath}.dependencies.after.json`],
    ['task.json', taskReceiptPath],
    ['resources.jsonl', `${receiptPath}.resources.jsonl`],
    ['phases.jsonl', phaseArchivePath],
    ['child.json', `${receiptPath}.child.json`],
    ['stdout.log', `${receiptPath}.stdout.log`],
    ['stderr.log', `${receiptPath}.stderr.log`],
  ];
  const artifacts = {};
  for (const [name, sourcePath] of candidates) {
    let sourceStat;
    try { sourceStat = lstatSync(sourcePath); }
    catch (readError) {
      if (readError?.code === 'ENOENT') continue;
      throw readError;
    }
    assert.ok(sourceStat.isFile() && !sourceStat.isSymbolicLink(),
      `Verifier task evidence is not a regular file: ${sourcePath}`);
    const bytes = readFileSync(sourcePath);
    const afterStat = lstatSync(sourcePath);
    assert.deepEqual({ dev: afterStat.dev, ino: afterStat.ino, size: afterStat.size,
      mtimeMs: afterStat.mtimeMs, ctimeMs: afterStat.ctimeMs },
    { dev: sourceStat.dev, ino: sourceStat.ino, size: sourceStat.size,
      mtimeMs: sourceStat.mtimeMs, ctimeMs: sourceStat.ctimeMs },
    `Verifier task evidence changed while being retained: ${sourcePath}`);
    assert.equal(bytes.byteLength, sourceStat.size, `Verifier task evidence read was short: ${sourcePath}`);
    const retainedPath = join(evidenceRoot, name);
    writeFileSync(retainedPath, bytes, { flag: 'wx', mode: 0o600 });
    artifacts[name] = { path: retainedPath, sizeBytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  assert.ok(artifacts['task.json'] && artifacts['phases.jsonl'],
    'Managed verifier evidence requires its terminal task receipt and retained phase archive');
  const manifestPath = join(evidenceRoot, 'manifest.json');
  const manifest = {
    schemaVersion: 'verifier-task-evidence-v1',
    taskId,
    runId: basename(evidenceRoot),
    sourceCommit,
    wrapperStatus: error ? 'failed' : 'completed',
    cleanup,
    childExitCode,
    ...(error ? { error: String(error?.message ?? error).slice(0, 2000) } : {}),
    childLogs: { stdout: 'stdout.log', stderr: 'stderr.log' },
    artifacts,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { flag: 'wx', mode: 0o600 });
  return manifestPath;
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
      'Licensed under the Sustainable Use License 1.0 (see LICENSE). Components with their own',
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
      'under the Sustainable Use License 1.0 (see LICENSE and NOTICE). You may use and modify',
      'it for your own internal business purposes, non-commercial purposes or personal use.',
      'You may distribute it or provide it to others only free of charge for non-commercial',
      'purposes. Commercial embedding, redistribution or provision requires a separate license.',
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
 * The public target's LICENSE text. Refuses when missing or when it is not the canonical
 * Sustainable Use License 1.0: publishing the wrong terms is not recoverable
 * once cloned.
 * @param {string} path
 */
export function readLicense(path) {
  if (!existsSync(path)) throw new PreviewError(`public target needs its LICENSE at ${path}`, 2);
  const text = readFileSync(path, 'utf8');
  if (!/^## Sustainable Use License\n\nVersion 1\.0\n/.test(text) || text !== readFileSync(PUBLIC_LICENSE_PATH, 'utf8')) {
    throw new PreviewError(`${path} is not the canonical Sustainable Use License 1.0 text`, 2);
  }
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
    else if (['--inputs-file', '--budget-from', '--child-estimate-ms', '--preparation-max-ms', '--operator-api-root', '--operator-api-source-receipt',
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
  if (argv[0] === 'bg-build-begin' || argv[0] === 'bg-build-run') {
    const flags = ['--context', '--sha256', '--pid', '--entry', '--outfile', '--profile', '--builder', '--repo'];
    const budgetPath = argv[0] === 'bg-build-run' && argv[17] === '--budget-from' ? argv[18] : undefined;
    assert.ok(argv.length === 1 + flags.length * 2 + (budgetPath ? 2 : 0) &&
      flags.every((flag, index) => argv[index * 2 + 1] === flag),
      'BG recipe requires its exact original transaction, digest, PID, command, builder and repository');
    const [contextPath, expectedHash, pidText, entry, outfile, profile, builder, repo] = flags.map((_, index) => argv[index * 2 + 2]);
    assert.ok(isAbsolute(contextPath) && /^[a-f0-9]{64}$/.test(expectedHash) && /^[1-9][0-9]*$/.test(pidText),
      'BG recipe transaction path, digest or PID is invalid');
    const bytes = readFileSync(contextPath);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedHash, 'BG transaction original digest changed');
    const transaction = JSON.parse(bytes.toString('utf8'));
    assert.deepEqual(transaction.recipe, { entry, outfile, profile }, 'BG recipe command differs from original transaction');
    const record = transaction.contexts.record;
    assert.equal(repo, record.prepared.root, 'BG recipe repository differs from selected generation');
    assert.equal(readBgFileIdentity(builder).sha256, record.invocation.builder.sha256,
      'BG recipe executing builder differs from original transaction');
    const actualNode = readBgFileIdentity(process.execPath);
    assert.ok(actualNode.realpath === record.invocation.node.realpath && actualNode.sha256 === record.invocation.node.sha256,
      'BG recipe actual Node differs from original transaction');
    if (argv[0] === 'bg-build-run') {
      const phasePath = `${contextPath}.phases.${pidText}.jsonl`;
      assertOutsideArchive(record.prepared.root, resolve(phasePath));
      const runPhase = verifierPhaseRunner(phasePath, process.env, `${phasePath}.child.json`);
      const publication = await runBgVerifierBuildRecipe({ transaction, ownerPid: Number(pidText), runPhase,
        ...(budgetPath ? { budget: { measurements: readVerifierPhaseMeasurements(budgetPath) } } : {}) });
      console.log(JSON.stringify(publication));
      return 0;
    }
    const binding = beginBgVerifierBuildTransaction({ transaction, ownerPid: Number(pidText) });
    const boundContext = join(transaction.stage, '.bg-build-context.json');
    // No caller may compile until BOTH exclusive records are complete. A failed
    // preflight retains its private stage for diagnosis and is never replayed.
    writeBgVerifierBinding(binding);
    console.log(boundContext);
    return 0;
  }
  if (argv[0] === 'bg-compiler') {
    assert.ok(argv[1] === '--context' && isAbsolute(argv[2] ?? '') && (argv[3] === '--' || argv[3] === '--check'),
      'bg-compiler requires --context <absolute original context> -- <recorded compiler argv>');
    const context = JSON.parse(await fs.readFile(argv[2], 'utf8'));
    if (argv[3] === '--check') {
      assert.equal(argv.length, 4, 'BG context check has unexpected arguments');
      const entries = context.schemaVersion === 'bg-build-contexts-v1'
        ? (validateBgVerifierBuildContexts(context), context.invocations.map(entry =>
          ({ record: { ...context.record, invocation: entry.original }, invocation: entry.invocation })))
        : [context];
      for (const entry of entries) verifyBgVerifierBuildRecord(entry.record, entry.invocation, 'before-build');
      return 0;
    }
    const selected = context.schemaVersion === 'bg-build-contexts-v1'
      ? selectBgVerifierBuildContext(context, argv.slice(4)) : context;
    const receipt = await compileBgVerifierInvocation({ ...selected, argv: argv.slice(4), expectedVersion: '0.25.0' });
    console.log(JSON.stringify(receipt));
    return 0;
  }
  const { cmd, opts } = parseArgs(argv);
  const log = (m) => console.error(`==> ${m}`);
  if (cmd === 'verifier-run') {
    if (!opts.repo || !opts.ref || !opts.receipt || !(opts.inputs || opts['inputs-file']) || !opts.command?.length)
      throw new PreviewError('verifier-run requires --repo, --ref, --receipt, --inputs or --inputs-file and -- <command>', 2);
    return runVerifierCommand({ repo: opts.repo, ref: opts.ref, receiptPath: opts.receipt,
      inputs: opts.inputs?.split(',').filter(Boolean) ?? [], inputsFile: opts['inputs-file'],
      tauriInputs: opts.tauriInputs === true, command: opts.command,
      budgetFrom: opts['budget-from'], childEstimateMs: opts['child-estimate-ms'] === undefined ? 0 : Number(opts['child-estimate-ms']),
      preparationMaxMs: opts['preparation-max-ms'] === undefined ? undefined : Number(opts['preparation-max-ms']) });
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
