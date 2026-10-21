import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import TOML from '@iarna/toml';
import fastGlob from 'fast-glob';

/**
 * Workspace manifest walk (plan-reuse-and-library-declarations-2026-10-20, D-013 #3).
 *
 * One reader for "which packages does this repository declare": the root
 * package.json, every npm workspace it lists, and every tracked Cargo.toml.
 * The plan reuse resolver (kind `package`) and the library checks (R-5) both
 * read it; scripts/check-lockfile-census.mjs can adopt it later instead of
 * keeping its own lockfile list.
 */

export interface WorkspaceManifest {
  /** Repo-relative manifest path, POSIX separators. */
  path: string;
  ecosystem: 'npm' | 'cargo';
  /** The manifest's own package / crate name, when it declares one. */
  name: string | null;
  /** Every dependency name the manifest declares (all dependency tables). */
  dependencies: string[];
}

const NPM_DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
const CARGO_DEPENDENCY_TABLES = ['dependencies', 'dev-dependencies', 'build-dependencies'] as const;

// Lazily promisified + memoized, never at module scope (lint:no-eager-execfile-promisify,
// EI-10161): a narrow node:child_process mock reaching this module transitively must not
// crash the importing test file at module-eval time (promisify(undefined)).
type ExecFileAsync = (
  file: string,
  args: string[],
  options: { cwd: string; maxBuffer: number; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;
let cachedExecFileAsync: ExecFileAsync | null = null;
function execFileAsync(
  file: string,
  args: string[],
  options: { cwd: string; maxBuffer: number; timeout: number },
): Promise<{ stdout: string; stderr: string }> {
  cachedExecFileAsync ??= promisify(execFile) as unknown as ExecFileAsync;
  return cachedExecFileAsync(file, args, options);
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function npmManifest(relPath: string, raw: string): WorkspaceManifest {
  const json = JSON.parse(raw) as Record<string, unknown>;
  const dependencies = new Set<string>();
  for (const field of NPM_DEPENDENCY_FIELDS) {
    const table = json[field];
    if (table && typeof table === 'object') for (const name of Object.keys(table)) dependencies.add(name);
  }
  return { path: relPath, ecosystem: 'npm', name: typeof json.name === 'string' ? json.name : null, dependencies: [...dependencies] };
}

function cargoTables(node: Record<string, unknown>, into: Set<string>): void {
  for (const table of CARGO_DEPENDENCY_TABLES) {
    const deps = node[table];
    if (deps && typeof deps === 'object') for (const name of Object.keys(deps)) into.add(name);
  }
}

/** Parse a Cargo.toml's dependency names, including workspace and per-target tables. */
export function parseCargoManifest(relPath: string, raw: string): WorkspaceManifest {
  const toml = TOML.parse(raw) as Record<string, unknown>;
  const dependencies = new Set<string>();
  cargoTables(toml, dependencies);
  const workspace = toml.workspace as Record<string, unknown> | undefined;
  if (workspace?.dependencies && typeof workspace.dependencies === 'object') {
    for (const name of Object.keys(workspace.dependencies)) dependencies.add(name);
  }
  const targets = toml.target as Record<string, Record<string, unknown>> | undefined;
  if (targets && typeof targets === 'object') for (const target of Object.values(targets)) cargoTables(target, dependencies);
  const pkg = toml.package as { name?: unknown } | undefined;
  return { path: relPath, ecosystem: 'cargo', name: typeof pkg?.name === 'string' ? pkg.name : null, dependencies: [...dependencies] };
}

/** Expand the root package.json `workspaces` globs (with `!` exclusions) to directories. */
async function npmWorkspaceDirs(repoRoot: string, rootJson: Record<string, unknown>): Promise<string[]> {
  const raw = rootJson.workspaces;
  const patterns = Array.isArray(raw) ? raw : Array.isArray((raw as { packages?: unknown })?.packages) ? (raw as { packages: unknown[] }).packages : [];
  const include = patterns.filter((p): p is string => typeof p === 'string' && !p.startsWith('!'));
  const exclude = patterns.filter((p): p is string => typeof p === 'string' && p.startsWith('!')).map((p) => p.slice(1));
  if (include.length === 0) return [];
  return fastGlob(include, { cwd: repoRoot, onlyDirectories: true, ignore: [...exclude, '**/node_modules/**'], followSymbolicLinks: false });
}

/** Tracked Cargo.toml files, across submodules; untracked build output never counts. */
async function trackedCargoManifests(repoRoot: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['ls-files', '--recurse-submodules', '--', '*Cargo.toml'], {
    cwd: repoRoot, maxBuffer: 8 * 1024 * 1024, timeout: 30_000,
  });
  return stdout.split('\n').map((line) => line.trim()).filter((line) => line && !line.includes('node_modules/'));
}

/**
 * Read every workspace manifest under `repoRoot`. Throws when the root
 * package.json cannot be read, so a caller can report "unavailable" instead of
 * treating an unreadable tree as "declares nothing".
 */
export async function readWorkspaceManifests(repoRoot: string): Promise<WorkspaceManifest[]> {
  const rootRaw = await readFile(path.join(repoRoot, 'package.json'), 'utf8');
  const rootJson = JSON.parse(rootRaw) as Record<string, unknown>;
  const manifests: WorkspaceManifest[] = [npmManifest('package.json', rootRaw)];
  const dirs = await npmWorkspaceDirs(repoRoot, rootJson);
  const npm = await Promise.all(dirs.map(async (dir) => {
    const rel = toPosix(path.join(dir, 'package.json'));
    try {
      return npmManifest(rel, await readFile(path.join(repoRoot, rel), 'utf8'));
    } catch {
      return null; // a workspace glob can match a directory with no manifest
    }
  }));
  manifests.push(...npm.filter((m): m is WorkspaceManifest => m !== null));
  const cargoPaths = await trackedCargoManifests(repoRoot).catch(() => [] as string[]);
  const cargo = await Promise.all(cargoPaths.map(async (rel) => {
    try {
      return parseCargoManifest(rel, await readFile(path.join(repoRoot, rel), 'utf8'));
    } catch {
      return null;
    }
  }));
  manifests.push(...cargo.filter((m): m is WorkspaceManifest => m !== null));
  return manifests;
}

/** Crate names treat `-` and `_` as the same name. */
const foldCrate = (name: string) => name.toLowerCase().replace(/_/g, '-');

export interface DeclaredPackageIndex {
  /** The manifests that declare `name` as a dependency or as their own package. */
  find(name: string): WorkspaceManifest[];
  /** True when some manifest declares `name` as a DEPENDENCY (not only as its own name). */
  isDependency(name: string): boolean;
}

/** Index a manifest set for name lookups (npm exact; Cargo `-`/`_` folded). */
export function indexDeclaredPackages(manifests: readonly WorkspaceManifest[]): DeclaredPackageIndex {
  const matches = (manifest: WorkspaceManifest, name: string, field: 'dependency' | 'any') => {
    const eq = manifest.ecosystem === 'cargo' ? (a: string) => foldCrate(a) === foldCrate(name) : (a: string) => a === name;
    return manifest.dependencies.some(eq) || (field === 'any' && manifest.name !== null && eq(manifest.name));
  };
  return {
    find: (name) => manifests.filter((manifest) => matches(manifest, name, 'any')),
    isDependency: (name) => manifests.some((manifest) => matches(manifest, name, 'dependency')),
  };
}
