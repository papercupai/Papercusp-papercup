#!/usr/bin/env node
/**
 * Copy the host's pgvector and pg_textsearch extensions into the embedded-postgres
 * binaries that `npm ci` installs under node_modules/@embedded-postgres/<platform>/native.
 *
 * Why: the zonky embedded-postgres binaries ship no extensions beyond the
 * contrib set, but the schema needs two more.
 *
 * - pgvector (REQUIRED). The schema declares `vector(N)` columns (e.g. migration
 *   349-code-recipes.sql). A fresh clone that ran only `npm ci` therefore boots
 *   its embedded database and then fails the first migration that needs vector:
 *   `type "vector" does not exist`.
 * - pg_textsearch (OPTIONAL; BM25 lexical ranking, plan
 *   bm25-lexical-search-evoke-adoption-2026-10-10). embedded-postgres-server
 *   preloads it only when this library file is in the tree
 *   (`presentPreloadLibraries`), so a tree without it still boots: the BM25
 *   migration skips its indexes and search ranks with the legacy tsvector path.
 *   Without this copy, every development boot of embedded Postgres, including
 *   `scripts/verify-tauri-headless.sh` with VERIFY_TAURI_ISOLATED_DB=1, silently
 *   ran the legacy ranking that the shipped Linux desktop does not.
 *
 * Release builds already copy both into the bundled sidecar
 * (papercusp-desktop/bin/build-desktop-sidecar.sh); this does the same for a
 * development checkout, so the documented from-source path works on a clean
 * machine (open-source-release-2026-09-29 P-008).
 *
 * Runs from the root postinstall. It never fails the install when an extension
 * is missing on the host: it prints the install command instead, because the
 * typecheck-only CI legs have no database at all. Pass --strict (or set
 * PAPERCUSP_EMBEDDED_PGVECTOR_STRICT=1) to make a missing REQUIRED source an error.
 *
 * A tree that already holds an extension is refreshed when the host's library
 * differs byte-for-byte (a host package upgrade), so the tree never keeps a stale
 * build the host has moved past.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { isCliEntry } from '../packages/operator-core/lib/util/cli-entry.ts';

/** Postgres major of an embedded-postgres package version such as "18.3.0-beta.17". */
export function embeddedPgMajor(version) {
  const match = /^(\d+)\./.exec(String(version ?? ''));
  return match ? Number(match[1]) : null;
}

/**
 * Where an embedded-postgres native tree expects extension files. Two layouts
 * exist (mirrors build-desktop-sidecar.sh): a flat one (lib/, share/extension)
 * and the Debian-style one (lib/postgresql, share/postgresql/extension).
 */
export function runtimeDirs(nativeDir) {
  if (existsSync(join(nativeDir, 'lib', 'pgcrypto.so')) && existsSync(join(nativeDir, 'share', 'extension'))) {
    return { libDir: join(nativeDir, 'lib'), extDir: join(nativeDir, 'share', 'extension') };
  }
  return {
    libDir: join(nativeDir, 'lib', 'postgresql'),
    extDir: join(nativeDir, 'share', 'postgresql', 'extension'),
  };
}

/** Candidate host locations of pgvector built for Postgres `major`, in preference order. */
export function hostPgvectorCandidates({ platform, major, env = process.env }) {
  const candidates = [];
  if (env.PAPERCUSP_PGVECTOR_LIB && env.PAPERCUSP_PGVECTOR_EXT_DIR) {
    candidates.push({ lib: env.PAPERCUSP_PGVECTOR_LIB, extDir: env.PAPERCUSP_PGVECTOR_EXT_DIR });
  }
  if (platform === 'linux') {
    candidates.push({
      lib: `/usr/lib/postgresql/${major}/lib/vector.so`,
      extDir: `/usr/share/postgresql/${major}/extension`,
    });
  } else if (platform === 'darwin') {
    for (const prefix of ['/opt/homebrew', '/usr/local']) {
      candidates.push({
        lib: `${prefix}/lib/postgresql@${major}/vector.dylib`,
        extDir: `${prefix}/share/postgresql@${major}/extension`,
      });
      candidates.push({
        lib: `${prefix}/lib/postgresql/vector.dylib`,
        extDir: `${prefix}/share/postgresql@${major}/extension`,
      });
    }
  }
  return candidates;
}

export function installHint(platform, major) {
  if (platform === 'linux') {
    return `sudo apt install postgresql-${major}-pgvector   (Debian/Ubuntu, from the PostgreSQL apt repository at https://wiki.postgresql.org/wiki/Apt)`;
  }
  if (platform === 'darwin') return `brew install pgvector   (built against postgresql@${major})`;
  return 'no automated pgvector source for this platform; embedding features fall back to in-memory';
}

/**
 * Candidate host locations of pg_textsearch built for Postgres `major`. Linux only:
 * no Homebrew formula or upstream darwin/Windows binary exists yet
 * (WI-6554700010008388), the same gap the sidecar build reports.
 */
export function hostPgTextsearchCandidates({ platform, major, env = process.env }) {
  const candidates = [];
  if (env.PAPERCUSP_PG_TEXTSEARCH_LIB && env.PAPERCUSP_PG_TEXTSEARCH_EXT_DIR) {
    candidates.push({
      lib: env.PAPERCUSP_PG_TEXTSEARCH_LIB,
      extDir: env.PAPERCUSP_PG_TEXTSEARCH_EXT_DIR,
      licence: env.PAPERCUSP_PG_TEXTSEARCH_LICENSE ?? null,
    });
  }
  if (platform === 'linux') {
    candidates.push({
      lib: `/usr/lib/postgresql/${major}/lib/pg_textsearch.so`,
      extDir: `/usr/share/postgresql/${major}/extension`,
      licence: `/usr/share/doc/postgresql-${major}-pg-textsearch/copyright`,
    });
  }
  return candidates;
}

/** {major, minor} of an embedded-postgres package version such as "18.3.0-beta.17". */
export function embeddedPgVersion(version) {
  const match = /^(\d+)\.(\d+)\./.exec(String(version ?? ''));
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
}

/**
 * The PostgreSQL minor a host extension package was built for, or null when unknown.
 * A pgdg extension package is compiled against the host's server headers and can call
 * symbols that only that minor (or later) exports: pg_textsearch 1.5.1 for 18.4 needs
 * `palloc_mul`, which an 18.3 server lacks. Measured 2026-10-11: the embedded 18.3.0-beta.17
 * postmaster refused to START with it in shared_preload_libraries; 18.4.0-beta.17 starts,
 * creates the extension and ranks with it. Read from dpkg's record of the installed
 * `postgresql-<major>` server (no process spawn); override with
 * PAPERCUSP_PG_TEXTSEARCH_BUILT_FOR (e.g. "18.4").
 */
export function hostServerMinor({ platform, major, env = process.env, readText = (p) => readFileSync(p, 'utf8') }) {
  const override = /^(\d+)\.(\d+)$/.exec(String(env.PAPERCUSP_PG_TEXTSEARCH_BUILT_FOR ?? ''));
  if (override) return Number(override[1]) === major ? Number(override[2]) : null;
  if (platform !== 'linux') return null;
  let status;
  try {
    status = readText('/var/lib/dpkg/status');
  } catch {
    return null;
  }
  for (const stanza of status.split(/\n\n+/)) {
    if (!new RegExp(`^Package: postgresql-${major}$`, 'm').test(stanza)) continue;
    if (!/^Status: install ok installed$/m.test(stanza)) continue;
    const version = new RegExp(`^Version: ${major}\\.(\\d+)`, 'm').exec(stanza);
    return version ? Number(version[1]) : null;
  }
  return null;
}

export function pgTextsearchInstallHint(platform, major) {
  if (platform === 'linux') {
    return `sudo apt install postgresql-${major}-pg-textsearch   (from the PostgreSQL apt repository); without it BM25 search falls back to legacy ts_rank_cd ranking`;
  }
  return 'no packaged pg_textsearch for this platform yet (WI-6554700010008388); BM25 search falls back to legacy ts_rank_cd ranking';
}

/**
 * The extensions this installer provisions. `stem` is both the library basename and
 * the control-file basename; SQL scripts are `<stem>--*.sql`. `required` decides
 * whether a missing host source fails a --strict run. A `licence` file on the chosen
 * candidate is copied beside the control file as `<stem>.LICENSE` (the PostgreSQL
 * licence requires its notice in every copy).
 */
export const EMBEDDED_EXTENSIONS = Object.freeze([
  Object.freeze({ name: 'pgvector', stem: 'vector', required: true, candidates: hostPgvectorCandidates, hint: installHint }),
  Object.freeze({
    name: 'pg_textsearch',
    stem: 'pg_textsearch',
    required: false,
    // Preloaded: a library the tree's postmaster cannot load stops it from STARTING
    // (not just CREATE EXTENSION), so an unproven build is never installed.
    preload: true,
    builtForMinor: hostServerMinor,
    candidates: hostPgTextsearchCandidates,
    hint: pgTextsearchInstallHint,
  }),
]);

/**
 * Every `node_modules/@embedded-postgres` directory npm placed under `root`, as
 * root-relative POSIX paths: the hoisted one, plus each one npm NESTED under a
 * workspace or package. npm nests a second copy whenever workspaces disagree on the
 * embedded-postgres version, and the nested copy is the one the disagreeing workspace
 * loads. Measured 2026-10-11: apps/slack-asana-bug-drill pins 18.3.0-beta.17 exactly,
 * so 18.3 stays hoisted while embedded-postgres-server (^18.4, plan
 * bm25-lexical-search-evoke-adoption-2026-10-10 D-014) gets 18.4 under
 * libs/papercusp/packages/embedded-postgres-server/node_modules. Scanning only the
 * hoisted directory left that tree, the one every embedded-postgres-server boot
 * uses, without extensions.
 *
 * Placements are read from package-lock.json (npm's own record of where it put each
 * package), so no filesystem walk is needed. The hoisted directory is always
 * included, so a checkout without a lock still provisions it.
 */
export function embeddedPgPackageDirs(root) {
  const dirs = new Set(['node_modules/@embedded-postgres']);
  let lock = null;
  try {
    lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  } catch {
    /* no or unreadable lock: the hoisted directory alone */
  }
  for (const key of Object.keys(lock?.packages ?? {})) {
    const match = /^((?:.+\/)?node_modules\/@embedded-postgres)\/[^/]+$/.exec(key);
    if (match) dirs.add(match[1]);
  }
  return [...dirs].sort();
}

function nativeTrees(root) {
  const trees = [];
  const seen = new Set();
  for (const rel of embeddedPgPackageDirs(root)) {
    const base = join(root, rel);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      // `.linux-x64-AbC123` is npm's reify staging copy (possibly a peer's install in
      // progress), never a package anyone loads — leave it alone.
      if (name.startsWith('.')) continue;
      const pkgDir = join(base, name);
      const nativeDir = join(pkgDir, 'native');
      if (!existsSync(nativeDir)) continue;
      // A symlinked directory can reach one tree by two paths; provision it once.
      let real = pkgDir;
      try {
        real = realpathSync(pkgDir);
      } catch {
        /* keep the literal path */
      }
      if (seen.has(real)) continue;
      seen.add(real);
      trees.push({ name, location: `${rel}/${name}`, pkgDir, nativeDir });
    }
  }
  return trees;
}

function sameBytes(a, b) {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/**
 * Copy then rename, never overwrite in place. copyFileSync onto an existing file
 * truncates and rewrites the SAME inode, and an embedded postgres that already has the
 * library mapped (a test database, a running desktop sidecar) can then fault with
 * SIGBUS. A rename swaps in a new inode; a running process keeps the old one.
 */
function replaceFile(src, dest) {
  const tmp = `${dest}.tmp-${process.pid}`;
  copyFileSync(src, tmp);
  renameSync(tmp, dest);
}

function copyExtension({ extension, source, libDir, extDir, libExt }) {
  mkdirSync(libDir, { recursive: true });
  mkdirSync(extDir, { recursive: true });
  replaceFile(source.lib, join(libDir, `${extension.stem}.${libExt}`));
  let sqlFiles = 0;
  for (const file of readdirSync(source.extDir)) {
    const isControl = file === `${extension.stem}.control`;
    const isScript = file.startsWith(`${extension.stem}--`) && file.endsWith('.sql');
    if (!isControl && !isScript) continue;
    replaceFile(join(source.extDir, file), join(extDir, file));
    if (isScript) sqlFiles += 1;
  }
  let licence = false;
  if (source.licence && existsSync(source.licence)) {
    replaceFile(source.licence, join(extDir, `${extension.stem}.LICENSE`));
    licence = true;
  }
  return { sqlFiles, licence };
}

/**
 * Provision every extension in `extensions` into every embedded-postgres native tree
 * under `root`. Returns a structured report; performs no process exit.
 * Each `trees[]` row is one (tree, extension) pair with status
 * present | installed | updated | missing-source | unknown-version.
 */
export function installEmbeddedExtensions({
  root = process.cwd(),
  platform = process.platform,
  env = process.env,
  log = console.log,
  extensions = EMBEDDED_EXTENSIONS,
} = {}) {
  const report = { trees: [], missingSource: [] };
  const libExt = platform === 'darwin' ? 'dylib' : 'so';
  for (const tree of nativeTrees(root)) {
    let version = null;
    try {
      version = JSON.parse(readFileSync(join(tree.pkgDir, 'package.json'), 'utf8')).version;
    } catch {
      /* unreadable package.json: major stays null */
    }
    const major = embeddedPgMajor(version);
    const { libDir, extDir } = runtimeDirs(tree.nativeDir);
    for (const extension of extensions) {
      const row = { tree: tree.name, location: tree.location, extension: extension.name };
      const treeLib = join(libDir, `${extension.stem}.${libExt}`);
      const present = existsSync(join(extDir, `${extension.stem}.control`)) && existsSync(treeLib);
      if (major === null) {
        report.trees.push({ ...row, status: present ? 'present' : 'unknown-version' });
        continue;
      }
      const source = extension
        .candidates({ platform, major, env })
        .find((candidate) => existsSync(candidate.lib) && existsSync(join(candidate.extDir, `${extension.stem}.control`)));
      if (present && (!source || sameBytes(source.lib, treeLib))) {
        report.trees.push({ ...row, status: 'present' });
        continue;
      }
      if (!source) {
        report.trees.push({ ...row, status: 'missing-source', major });
        report.missingSource.push({
          tree: tree.name,
          location: tree.location,
          extension: extension.name,
          required: extension.required,
          major,
          hint: extension.hint(platform, major),
        });
        continue;
      }
      if (extension.preload) {
        const builtFor = extension.builtForMinor({ platform, major, env });
        const treeMinor = embeddedPgVersion(version)?.minor ?? null;
        if (builtFor === null || treeMinor === null || treeMinor < builtFor) {
          report.trees.push({ ...row, status: 'incompatible', major, treeMinor, builtFor });
          report.missingSource.push({
            tree: tree.name,
            location: tree.location,
            extension: extension.name,
            required: extension.required,
            major,
            incompatible: true,
            hint:
              `refusing ${extension.name}: the host build targets PostgreSQL ${major}.${builtFor ?? '?'} but ${tree.location} ` +
              `is ${major}.${treeMinor ?? '?'}; a preloaded library the server cannot load stops it from starting. ` +
              `Bump embedded-postgres to >= ${major}.${builtFor ?? '?'}.`,
          });
          continue;
        }
      }
      const { sqlFiles, licence } = copyExtension({ extension, source, libDir, extDir, libExt });
      const status = present ? 'updated' : 'installed';
      report.trees.push({ ...row, status, major, from: source.lib, sqlFiles, licence });
      log(`embedded-extensions: ${status} ${extension.name} for PG ${major} into ${tree.location} from ${source.lib}`);
    }
  }
  return report;
}

/** Repair required extensions after dependency replacement, before a fresh PG boot. */
export function ensureRequiredEmbeddedExtensions(options = {}) {
  const extensions = (options.extensions ?? EMBEDDED_EXTENSIONS).filter(extension => extension.required);
  const report = installEmbeddedExtensions({ ...options, extensions });
  if (extensions.length > 0 && report.trees.length === 0) {
    throw new Error('no embedded-postgres native installation found; install the repository dependencies before starting a private database');
  }
  const unavailable = report.trees.filter(row => !['present', 'installed', 'updated'].includes(row.status));
  if (unavailable.length > 0) {
    const details = unavailable.map(row => {
      const missing = report.missingSource.find(miss => miss.location === row.location && miss.extension === row.extension);
      return missing ? missingWarning(missing) : `${row.location}: required ${row.extension} unavailable (${row.status}); reinstall the embedded-postgres package`;
    });
    throw new Error(details.join('\n'));
  }
  return report;
}

export function missingWarning(miss) {
  const where = miss.location ?? `@embedded-postgres/${miss.tree}`;
  if (miss.incompatible) {
    // The host HAS the extension; it was built for a newer server than this tree.
    // "not found on this machine" would send the reader to install what they have.
    return `embedded-extensions: note — ${where} boots without ${miss.extension}.\n  ${miss.hint}`;
  }
  if (miss.required) {
    return (
      `embedded-extensions: WARNING — ${miss.extension} for PostgreSQL ${miss.major} not found on this machine, so ${where} cannot create it and a fresh database will fail its migrations.\n` +
      `  Install it, then re-run: node scripts/install-embedded-pgvector.mjs\n  ${miss.hint}`
    );
  }
  return (
    `embedded-extensions: note — ${miss.extension} for PostgreSQL ${miss.major} not found on this machine; ${where} boots without it.\n` +
    `  To enable it, install it and re-run: node scripts/install-embedded-pgvector.mjs\n  ${miss.hint}`
  );
}

function main() {
  const strict = process.argv.includes('--strict') || process.env.PAPERCUSP_EMBEDDED_PGVECTOR_STRICT === '1';
  const report = installEmbeddedExtensions();
  for (const miss of report.missingSource) console.warn(missingWarning(miss));
  if (strict && report.missingSource.some((miss) => miss.required)) process.exitCode = 1;
}

if (isCliEntry(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`embedded-extensions: setup failed: ${error instanceof Error ? error.message : String(error)}`);
    if (process.argv.includes('--strict')) process.exitCode = 1;
  }
}
