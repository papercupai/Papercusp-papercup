#!/usr/bin/env node
// Lock-vs-tree completeness audit for a dependency generation (WI-6554700010008514).
//
// dependency-generation.sh indexes a generation under its INPUT key (the lockfile + patch
// digests) and trusts that the copied node_modules trees realise those lockfiles. Nothing
// checked it: a generation published from a root whose trees were missing
// node_modules/sharp/node_modules/semver was indexed under input 8f48c4a6 and reused by
// every gate verify that shared the key, and the gate's `npm ls` (lint:reachable-advisories)
// went red with ADVISORY_GATE_UNDETERMINED on every run (2026-10-11).
//
// This audit is the missing check. For every lockfile in the input manifest whose directory
// has an installed node_modules in the tree, every installed (`node_modules/…`) lock entry
// must be present on disk at the locked version:
//   - a package entry needs <tree>/<lockdir>/<key>/package.json whose "version" equals the
//     lock's version (a missing or different version is a defect);
//   - a `link: true` entry needs a path (usually a symlink) at <tree>/<lockdir>/<key>;
//   - an `optional: true` entry may be absent (npm skips optional deps that do not fit the
//     platform or fail to build), but if present its version must still match.
// A nested lockfile whose node_modules is absent is reported as not-installed:
// the generation never claimed that standalone install. Required root lock entries
// must still be checked when the entire root install is missing. A lockfile whose
// directory is a WORKSPACE of an enclosing audited lockfile (the enclosing lock has a
// `<member dir>` package key) is skipped as workspace-member: the enclosing install owns
// that node_modules, and the member's own lockfile is never installed standalone.
//
// No installed dependencies: Node built-ins plus the source-only CLI entry helper,
// so release shell scripts can run it with the operator down and before npm install.
//
// Usage:
//   dependency-lock-tree-audit.mjs --tree-root <dir> --lock-root <dir> --manifest <file>
// --manifest is `rel<TAB>sha256` lines (dependency_generation_input_manifest output); only
// lockfile paths are read. Lockfiles are read from --lock-root, installed packages from
// --tree-root (the two are the same directory for a live build root).
// Stdout: `LOCK_TREE_AUDIT lockfiles=N audited=N skipped=N entries=N defects=N` summary,
// then one `LOCK_TREE_LOCKFILE<TAB><status><TAB><rel><TAB><detail>` line per lockfile, then
// `LOCK_TREE_DEFECT<TAB><kind><TAB><path><TAB><detail>` lines (at most MAX_DEFECTS).
// Exit 0 = complete, 3 = defects found, 2 = misuse / unreadable input.

import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, posix, resolve } from 'node:path';
import { isCliEntry } from '../../../../packages/operator-core/lib/util/cli-entry.ts';

export const MAX_DEFECTS = 50;

// better-sqlite3 loads its native binding only when a database is opened. A
// manifest/version or import-only check admits the missing-binding incident
// EI-26892635373712820. Keep this node-only so the publisher works offline.
const SQLITE_RUNTIME_PROBE = `
try {
  const Database = require(process.argv[1]);
  const db = new Database(':memory:');
  try {
    if (db.prepare('SELECT 1 AS ok').get()?.ok !== 1) throw new Error('SQLite query returned an unexpected result');
  } finally { db.close(); }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
`;

function sqliteRuntimeFailure(packagePath) {
  const result = spawnSync(process.execPath, ['--eval', SQLITE_RUNTIME_PROBE, resolve(packagePath)], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
  });
  if (result.status === 0) return null;
  return String(result.error?.message || result.stderr || `native probe exited ${result.status ?? result.signal}`)
    .replace(/\s+/g, ' ').trim().slice(0, 2000);
}

/** Parse `rel<TAB>digest` manifest text into the list of lockfile paths. */
export function lockfilesFromManifest(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    if (tab < 1) throw new Error(`malformed manifest line: ${line}`);
    const rel = line.slice(0, tab);
    const base = posix.basename(rel);
    if (base === 'package-lock.json' || base === 'npm-shrinkwrap.json') out.push(rel);
  }
  return out;
}

function defaultFs() {
  return {
    exists(path) {
      try {
        lstatSync(path);
        return true;
      } catch {
        return false;
      }
    },
    readJson(path) {
      try {
        return JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        return null;
      }
    },
  };
}

/**
 * Audit one lockfile against the tree. `lockDir` is the lockfile's repo-relative directory
 * ('' for the root). Returns { installed, entries, defects } — installed=false means the
 * tree has no node_modules for this lockfile and nothing was checked.
 */
export function auditLockfile({ lock, lockDir, treeRoot, fs = defaultFs() }) {
  const base = lockDir ? join(treeRoot, lockDir) : treeRoot;
  if (!fs.exists(join(base, 'node_modules')) && (lockDir || !Object.entries(lock?.packages ?? {})
    .some(([key, entry]) => key.startsWith('node_modules/') && entry?.optional !== true))) {
    return { installed: false, entries: 0, defects: [] };
  }
  const defects = [];
  let entries = 0;
  for (const [key, raw] of Object.entries(lock?.packages ?? {})) {
    if (!key.includes('node_modules/')) continue;
    const entry = raw ?? {};
    entries += 1;
    const rel = lockDir ? posix.join(lockDir, key) : key;
    const path = join(base, key);
    if (entry.link === true) {
      if (!fs.exists(path)) defects.push({ kind: 'missing-link', path: rel, detail: `-> ${entry.resolved ?? '?'}` });
      continue;
    }
    const manifest = fs.readJson(join(path, 'package.json'));
    if (manifest === null) {
      if (entry.optional === true) continue;
      defects.push({ kind: 'missing', path: rel, detail: `locked ${entry.version ?? '?'}` });
      continue;
    }
    if (entry.version != null && manifest.version !== entry.version) {
      defects.push({
        kind: 'version-mismatch',
        path: rel,
        detail: `locked ${entry.version} installed ${manifest.version ?? 'none'}`,
      });
    } else if (key === 'node_modules/better-sqlite3' || key.endsWith('/node_modules/better-sqlite3')) {
      // Probe each exact installed copy, including workspace/private copies,
      // rather than accidentally resolving a healthy hoisted or host package.
      const detail = sqliteRuntimeFailure(path);
      if (detail !== null) defects.push({ kind: 'native-runtime-unusable', path: rel, detail });
    }
  }
  return { installed: true, entries, defects };
}

function lockDirOf(rel) {
  const dir = posix.dirname(rel);
  return dir === '.' ? '' : dir;
}

/**
 * The enclosing lockfile that declares `lockDir` as one of its workspaces, if any. A
 * workspace member's own lockfile is never installed standalone: the enclosing lockfile
 * owns that directory's node_modules (as `<member>/node_modules/…` keys), so auditing the
 * member lockfile against it would report the enclosing install's hoisting as defects.
 */
export function enclosingWorkspaceOwner(lockDir, auditedLocks) {
  for (const { dir, lock } of auditedLocks) {
    if (dir === lockDir) continue;
    if (dir !== '' && !lockDir.startsWith(`${dir}/`)) continue;
    const memberKey = dir === '' ? lockDir : lockDir.slice(dir.length + 1);
    if (Object.hasOwn(lock?.packages ?? {}, memberKey)) return dir === '' ? '.' : dir;
  }
  return null;
}

/**
 * Audit every lockfile named by the manifest, shallowest first so an enclosing lockfile is
 * known before its workspace members. `lockfiles[]` in the result records each decision:
 * status audited | not-installed | workspace-member (with `owner`).
 */
export function auditTree({ treeRoot, lockRoot, lockfiles, installedTrees = [], fs = defaultFs() }) {
  const summary = {
    lockfiles: lockfiles.length,
    audited: 0,
    skipped: 0,
    entries: 0,
    defects: [],
    decisions: [],
  };
  const ordered = [...lockfiles].sort(
    (a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0),
  );
  const auditedLocks = [];
  const lockedPaths = new Set();
  for (const rel of ordered) {
    const lock = fs.readJson(join(lockRoot, rel));
    if (lock === null) throw new Error(`unreadable lockfile: ${join(lockRoot, rel)}`);
    const lockDir = lockDirOf(rel);
    // Supplemental member locks can bind physically installed nested paths even
    // when their vestigial full graph is not an installation obligation.
    for (const key of Object.keys(lock.packages ?? {})) {
      if (key.includes('node_modules/')) lockedPaths.add(posix.join(lockDir, key));
    }
    const owner = enclosingWorkspaceOwner(lockDir, auditedLocks);
    if (owner !== null) {
      summary.skipped += 1;
      summary.decisions.push({ rel, status: 'workspace-member', owner, entries: 0, defects: 0 });
      continue;
    }
    const result = auditLockfile({ lock, lockDir, treeRoot, fs });
    if (!result.installed) {
      summary.skipped += 1;
      summary.decisions.push({ rel, status: 'not-installed', entries: 0, defects: 0 });
      continue;
    }
    auditedLocks.push({ dir: lockDir, lock });
    summary.audited += 1;
    summary.entries += result.entries;
    summary.defects.push(...result.defects);
    summary.decisions.push({
      rel,
      status: 'audited',
      entries: result.entries,
      defects: result.defects.length,
    });
  }
  // Forward completeness alone admits arbitrary extra packages. Reuse the
  // publisher's exact tree population instead of walking emitted build copies.
  const scan = (tree) => {
    for (const name of readdirSync(join(treeRoot, tree)).sort()) {
      if (name.startsWith('.')) continue; // Existing hidden-entry/loaded-module guards own these.
      const names = name.startsWith('@')
        ? readdirSync(join(treeRoot, tree, name)).filter(child => !child.startsWith('.')).map(child => `${name}/${child}`)
        : [name];
      for (const name of names) {
        const path = posix.join(tree, name);
        if (!lockedPaths.has(path)) summary.defects.push({ kind: 'unlocked', path, detail: 'installed package has no input lock entry' });
        const physical = join(treeRoot, path);
        if (!lstatSync(physical).isSymbolicLink() && fs.exists(join(physical, 'node_modules'))) scan(posix.join(path, 'node_modules'));
      }
    }
  };
  for (const tree of installedTrees) {
    if (!tree || tree.startsWith('/') || tree.split('/').some(part => !part || part === '.' || part === '..')
        || /[\\\x00-\x1f]/.test(tree) || posix.basename(tree) !== 'node_modules') throw new Error('invalid installed tree path');
    scan(tree);
  }
  return summary;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!['--tree-root', '--lock-root', '--manifest', '--installed-trees'].includes(flag) || value === undefined) {
      throw new Error(`unknown or incomplete argument: ${flag}`);
    }
    out[flag.slice(2)] = value;
  }
  for (const key of ['tree-root', 'lock-root', 'manifest']) {
    if (!out[key]) throw new Error(`--${key} is required`);
  }
  return out;
}

function main(argv) {
  let args;
  let summary;
  try {
    args = parseArgs(argv);
    const lockfiles = lockfilesFromManifest(readFileSync(args.manifest, 'utf8'));
    const installedTrees = args['installed-trees'] ? readFileSync(args['installed-trees'], 'utf8').split('\n').filter(Boolean) : [];
    summary = auditTree({ treeRoot: args['tree-root'], lockRoot: args['lock-root'], lockfiles, installedTrees });
  } catch (error) {
    process.stderr.write(`dependency-lock-tree-audit: ${error.message}\n`);
    return 2;
  }
  process.stdout.write(
    `LOCK_TREE_AUDIT lockfiles=${summary.lockfiles} audited=${summary.audited} skipped=${summary.skipped} entries=${summary.entries} defects=${summary.defects.length}\n`,
  );
  for (const d of summary.decisions) {
    const detail = d.status === 'workspace-member' ? `owner=${d.owner}` : `entries=${d.entries} defects=${d.defects}`;
    process.stdout.write(`LOCK_TREE_LOCKFILE\t${d.status}\t${d.rel}\t${detail}\n`);
  }
  for (const defect of summary.defects.slice(0, MAX_DEFECTS)) {
    process.stdout.write(`LOCK_TREE_DEFECT\t${defect.kind}\t${defect.path}\t${defect.detail}\n`);
  }
  if (summary.defects.length > MAX_DEFECTS) {
    process.stdout.write(`LOCK_TREE_DEFECT\ttruncated\t-\t${summary.defects.length - MAX_DEFECTS} more\n`);
  }
  return summary.defects.length === 0 ? 0 : 3;
}

if (isCliEntry(import.meta.url)) process.exitCode = main(process.argv.slice(2));
