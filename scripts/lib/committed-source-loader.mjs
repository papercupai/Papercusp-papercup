// Committed-source loader (WI-10005764 — residue of WI-10005745, plan
// personal-data-reader-set-labels-2026-10-01, Decisions D-011/D-012).
//
// The restricted-hold census decides whether code a restricted session wrote may run with the
// network. The census itself is ~5,600 operator-core modules in the SAME shared tree, so a held
// restricted write INTO that closure would execute inside the unrestricted census process before
// any refusal could happen. D-011 keeps restricted writes out of every commit, so a file's HEAD
// blob is a source no restricted session can have written. Loaded as
//
//     node --import <this file> --import tsx <entry>      (THIS FIRST — see below)
//
// it makes that process execute only committed bytes for every ES module inside a git checkout:
//   committed    the bytes read equal the file's HEAD blob (git's own blob hash): they run as read;
//   substituted  the bytes differ from HEAD: the HEAD blob runs instead, so a dirty file runs its
//                committed version (one stderr line names it);
//   uncommitted  no HEAD blob and git does not ignore the path: it can only be new, uncommitted
//                code, so loading it throws and the census fails closed;
//   commonjs     a checkout module reached through CommonJS never passes the ES load hook, so the
//                text Module.prototype._compile receives is judged instead: an exact HEAD match (or a
//                git-ignored path) runs; anything else — dirty, uncommitted, or rewritten by a
//                CommonJS loader hook such as tsx — throws, since CommonJS cannot safely swap in the
//                HEAD text. Committed plugin adapters (libs/papercusp/plugins/*/index.cjs) therefore
//                load in as-committed test trees. The census closure is still ES-only; the
//                committed-source tests pin that by running the real census under this loader.
// Outside every checkout (node's own modules) and under real node_modules dependencies, bytes
// run as read. Workspace symlinks are judged at their real target, which may be tracked source.
//
// Order matters: hooks registered later run FIRST. Registered before tsx, tsx's load hook calls
// this one through nextLoad for the raw bytes and then transforms whatever this one returns.
// Resolution is unchanged (on disk), so a HEAD version importing a path that is gone from disk
// fails to resolve — fail-closed again, never an unjudged run.
//
// Dependency-free (node: builtins only) on purpose. This is defense-in-depth for source identity,
// not the trust root for network permission: it and the door that loads it run from the live tree.
// The already-running operator boundary must decide source holds before it spawns integration-tree
// code; the installed PreToolUse hook applies that same decision to client-native egress.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, appendFileSync, constants as fsConstants, existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import Module, { register } from 'node:module';
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { threadId } from 'node:worker_threads';

/** When set to a file path, one JSON line per judged module is appended there (tests, debugging). */
export const COMMITTED_SOURCE_AUDIT_ENV = 'PAPERCUSP_COMMITTED_SOURCE_AUDIT';
/** Prefix of every line this loader writes to stderr. */
export const COMMITTED_SOURCE_MARKER = 'COMMITTED_SOURCE';
/**
 * When set to a file path, one JSON line is appended there for every checkout module this loader
 * did NOT run as read: a substitution (its HEAD bytes ran instead) or a refusal
 * (WI-6554700010009516). The stderr line says the same, but stderr goes wherever the process's
 * parent sends it, and a test that spawns `node` (inheriting NODE_OPTIONS, so this loader) captures
 * its child's stderr: the launcher that prints the verdict never sees it. Unlike the audit channel
 * this stays silent for committed modules, so a launcher can collect it from every process it
 * starts at the cost of one line per dirty module.
 */
export const COMMITTED_SOURCE_NOTICE_ENV = 'PAPERCUSP_COMMITTED_SOURCE_NOTICES';
/** `schemaVersion` of every notice line. */
export const COMMITTED_SOURCE_NOTICE_SCHEMA = 'committed-source-notice-v1';

const HOOKS_QUERY = 'committed-source-hooks';
const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const COMMITTED_SOURCE_GIT_ENV = 'PAPERCUSP_COMMITTED_SOURCE_GIT';
const GIT_UNAVAILABLE_SENTINEL = 'unavailable-at-loader-registration';

/** Resolve git once before registering the hook, then propagate the pin to child Node processes. */
function resolveGitExecutable(env = process.env) {
  const configured = env[COMMITTED_SOURCE_GIT_ENV];
  if (configured === GIT_UNAVAILABLE_SENTINEL) return null;
  if (configured && !isAbsolute(configured)) {
    throw new Error(`${COMMITTED_SOURCE_MARKER} ${COMMITTED_SOURCE_GIT_ENV} must be an absolute executable path`);
  }
  const executableName = process.platform === 'win32' ? 'git.exe' : 'git';
  const candidates = configured
    ? [configured]
    : String(env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => join(directory, executableName));
  for (const candidate of candidates) {
    try {
      const resolved = realpathSync(candidate);
      if (!statSync(resolved).isFile()) continue;
      accessSync(resolved, fsConstants.X_OK);
      return resolved;
    } catch {
      // Keep searching PATH; an explicitly configured path still fails closed below.
    }
  }
  if (configured) {
    throw new Error(`${COMMITTED_SOURCE_MARKER} could not resolve the configured git executable for checkout reads`);
  }
  return null;
}

let gitExecutable = null;

/** git's object id for `bytes` as a blob, in the object format `like` uses (sha1 or sha256). */
export function gitBlobId(bytes, like = '') {
  const algorithm = like.length === 64 ? 'sha256' : 'sha1';
  return createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

const topByDir = new Map();
/** The working-tree root of the innermost checkout (superproject or submodule) holding `file`, or null. */
function checkoutTop(file) {
  const seen = [];
  let dir = dirname(file);
  for (;;) {
    if (topByDir.has(dir)) {
      const top = topByDir.get(dir);
      for (const d of seen) topByDir.set(d, top);
      return top;
    }
    seen.push(dir);
    const marker = join(dir, '.git');
    if (existsSync(marker)) {
      // A home directory may hold only .git/info/exclude for ignore tooling,
      // without being a checkout. Exempt that exact metadata-only shape, not
      // arbitrary unreadable repositories: missing HEAD in a real/damaged
      // gitdir must still fail closed, as must a malformed worktree .git file.
      const entries = statSync(marker).isDirectory() ? readdirSync(marker) : null;
      if (entries === null || entries.length !== 1 || entries[0] !== 'info') {
        for (const d of seen) topByDir.set(d, dir);
        return dir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      for (const d of seen) topByDir.set(d, null);
      return null;
    }
    dir = parent;
  }
}

function git(top, args, opts = {}) {
  if (!gitExecutable) {
    throw new Error(`${COMMITTED_SOURCE_MARKER} no absolute git executable was available at loader registration for checkout reads`);
  }
  return execFileSync(gitExecutable, ['-C', top, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

const treeByTop = new Map();
/** `relative path -> blob id` for every file in `top`'s HEAD commit. Throws when HEAD is unreadable. */
function headTree(top) {
  let tree = treeByTop.get(top);
  if (tree) return tree;
  tree = new Map();
  const out = git(top, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD']).toString('utf8');
  for (const entry of out.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    const [mode, type, id] = entry.slice(0, tab).split(' ');
    if (type === 'blob' && mode !== '120000') tree.set(entry.slice(tab + 1), id);
  }
  treeByTop.set(top, tree);
  return tree;
}

function isIgnored(top, rel) {
  try {
    git(top, ['check-ignore', '-q', '--', rel]);
    return true;
  } catch (error) {
    if (error && error.status === 1) return false;
    throw error;
  }
}

/** Where `file` sits: outside every checkout, under node_modules, or a checkout path. */
function locate(file) {
  // Node can preserve a workspace package's node_modules symlink in its module URL.
  // Classify the target before exempting dependencies, for both ESM and CommonJS.
  const target = realpathSync(file);
  const top = checkoutTop(target);
  if (!top) return { place: 'outside' };
  const rel = relative(top, target).split(sep).join('/');
  if (rel.split('/').includes('node_modules')) return { place: 'dependency', top, rel };
  return { place: 'checkout', top, rel };
}

/**
 * Judge the bytes about to run for `file`.
 * @returns {{ kind: 'outside' | 'dependency' | 'committed' | 'ignored', rel?: string, top?: string }
 *   | { kind: 'substituted', rel: string, top: string, head: Buffer }
 *   | { kind: 'uncommitted', rel: string, top: string }}
 */
export function judgeModuleBytes(file, bytes) {
  const where = locate(file);
  if (where.place !== 'checkout') return { kind: where.place, rel: where.rel, top: where.top };
  const { top, rel } = where;
  const id = headTree(top).get(rel);
  if (id === undefined) return { kind: isIgnored(top, rel) ? 'ignored' : 'uncommitted', rel, top };
  if (gitBlobId(bytes, id) === id) return { kind: 'committed', rel, top };
  return { kind: 'substituted', rel, top, head: git(top, ['cat-file', 'blob', id]) };
}

/** Vite writes bundled ESM configs to node_modules/.vite-temp/<config>.timestamp-*.mjs. */
function viteTempConfigName(file) {
  if (basename(dirname(file)) !== '.vite-temp' || basename(dirname(dirname(file))) !== 'node_modules') return null;
  const match = /^(.+)\.timestamp-\d+-[0-9a-f]*\.mjs$/i.exec(basename(file));
  return match?.[1] ?? null;
}

/** Vite's config bundler embeds its esbuild input source map in both CJS and ESM output. */
function viteInlineSourceMap(bytes) {
  const source = bytes.toString('utf8');
  const match = /(?:^|\n)\/\/[#@]\s*sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)\s*$/.exec(source);
  if (!match) return null;
  try {
    const map = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
    if (!map || typeof map.sourceRoot !== 'string' || !map.sourceRoot.startsWith('file:')
      || !Array.isArray(map.sources) || !Array.isArray(map.sourcesContent)
      || map.sources.length !== map.sourcesContent.length) return null;
    return map;
  } catch {
    return null;
  }
}

function viteSourceMapPath(map, source) {
  if (typeof source !== 'string' || !source) return null;
  try {
    const url = new URL(source, map.sourceRoot);
    return url.protocol === 'file:' ? fileURLToPath(url) : null;
  } catch {
    return null;
  }
}

function viteFileScopePrefix(file) {
  return 'const __vite_injected_original_dirname = ' + JSON.stringify(dirname(file)) + ';'
    + 'const __vite_injected_original_filename = ' + JSON.stringify(file) + ';'
    + 'const __vite_injected_original_import_meta_url = ' + JSON.stringify(pathToFileURL(file).href) + ';';
}

function hasViteFileScopePrefix(file, source) {
  const prefix = viteFileScopePrefix(file);
  if (source.startsWith(prefix)) return true;
  if (!source.startsWith('#!')) return false;
  const newline = source.indexOf('\n');
  return newline < 0
    ? source.endsWith(prefix)
    : source.startsWith(prefix, newline + 1);
}

/** Vite prefixes each JS/TS source with these scope constants before esbuild maps it. */
function viteSourceMatchesHead(file, source, head) {
  const headSource = head.toString('utf8');
  if (source === headSource) return true;

  let shebang = '';
  if (headSource.startsWith('#!')) {
    const newline = headSource.indexOf('\n');
    shebang = headSource.slice(0, newline < 0 ? headSource.length : newline + 1);
  }
  if (!source.startsWith(shebang)) return false;

  const headBody = headSource.slice(shebang.length).trimEnd();
  const mappedBody = source.slice(shebang.length).trimEnd();
  const prefix = viteFileScopePrefix(file);
  if (!mappedBody.startsWith(prefix)) return false;
  const remainder = mappedBody.slice(prefix.length);
  return remainder === headBody
    || (remainder.startsWith('const __vite_injected_original_import_meta_resolve = ')
      && remainder.endsWith(';' + headBody));
}

function unverifiableViteConfigBundle(file, reason) {
  let where;
  try {
    where = locate(file);
  } catch {
    where = { place: 'outside' };
  }
  return {
    recognized: true,
    refused: true,
    reason,
    verdict: { kind: 'unverifiable', rel: where.rel ?? basename(file), top: where.top },
  };
}

/**
 * Judge Vite's compiled config by the exact source bytes embedded in its inline map. A Vite
 * transform is safe only when every checkout source maps to HEAD (after Vite's known scope prefix);
 * dirty or new source cannot be substituted into an already compiled bundle.
 */
function judgeViteConfigBundle(file, bytes) {
  const tempConfigName = viteTempConfigName(file);
  const map = viteInlineSourceMap(bytes);
  if (!map) {
    return tempConfigName
      ? unverifiableViteConfigBundle(file, 'inline-source-map-missing-or-invalid')
      : null;
  }

  const rows = map.sources.map((source, index) => ({
    file: viteSourceMapPath(map, source),
    source: map.sourcesContent[index],
  }));
  if (rows.some((row) => !row.file)) {
    return tempConfigName
      ? unverifiableViteConfigBundle(file, 'source-map-path-unresolvable')
      : null;
  }

  const mainRows = rows.filter((row) => {
    if (typeof row.source !== 'string' || !hasViteFileScopePrefix(row.file, row.source)) return false;
    if (tempConfigName) return basename(row.file) === tempConfigName;
    try {
      return realpathSync(row.file) === realpathSync(file);
    } catch {
      return basename(row.file) === basename(file);
    }
  });
  if (mainRows.length !== 1) {
    if (tempConfigName) return unverifiableViteConfigBundle(file, 'main-source-not-found-or-ambiguous');
    const hasViteSources = rows.some((row) => typeof row.source === 'string'
      && row.file && hasViteFileScopePrefix(row.file, row.source));
    return hasViteSources
      ? unverifiableViteConfigBundle(file, 'main-source-not-found-or-ambiguous')
      : null;
  }
  const main = mainRows[0];
  let mainVerdict = null;

  for (const row of rows) {
    let where;
    try {
      where = locate(row.file);
    } catch {
      return tempConfigName
        ? unverifiableViteConfigBundle(file, 'source-path-unavailable')
        : null;
    }
    if (where.place !== 'checkout') {
      if (row === main) mainVerdict = { kind: where.place, rel: where.rel, top: where.top };
      continue;
    }
    if (typeof row.source !== 'string') {
      return tempConfigName
        ? unverifiableViteConfigBundle(file, 'source-content-missing')
        : null;
    }

    const verdict = judgeModuleBytes(row.file, Buffer.from(row.source, 'utf8'));
    if (verdict.kind === 'committed' || verdict.kind === 'ignored') {
      if (row === main) mainVerdict = verdict;
      continue;
    }
    if (verdict.kind === 'substituted' && viteSourceMatchesHead(row.file, row.source, verdict.head)) {
      if (row === main) mainVerdict = { kind: 'committed', rel: verdict.rel, top: verdict.top };
      continue;
    }
    return {
      recognized: true,
      refused: true,
      reason: verdict.kind === 'uncommitted' ? 'uncommitted-source' : 'source-differs-from-head',
      verdict,
    };
  }

  return {
    recognized: true,
    refused: false,
    verdict: mainVerdict ?? { kind: 'committed', rel: main.file, top: locate(main.file).top },
  };
}

function audit(record) {
  const target = process.env[COMMITTED_SOURCE_AUDIT_ENV];
  if (target) appendFileSync(target, `${JSON.stringify(record)}\n`);
}

/**
 * Append one notice line (see COMMITTED_SOURCE_NOTICE_ENV). Reporting must never change what runs,
 * so a failed append is said on stderr rather than thrown into the module load.
 * `top` is the checkout the module belongs to, so a reader can tell its own tree from a scratch one.
 * @param {{ kind: 'substituted' | 'refused', via: 'esm' | 'cjs', rel: string, top: string, reason?: string }} record
 */
function notice(record) {
  const target = process.env[COMMITTED_SOURCE_NOTICE_ENV];
  if (!target) return;
  const line = JSON.stringify({
    schemaVersion: COMMITTED_SOURCE_NOTICE_SCHEMA, ...record, pid: process.pid, entry: entryLabel,
  });
  try {
    appendFileSync(target, `${line}\n`);
  } catch (error) {
    process.stderr.write(
      `${COMMITTED_SOURCE_MARKER} notice-unrecorded ${record.rel}: could not append to ${target} (${error?.code ?? error})\n`,
    );
  }
}

function toBuffer(source) {
  if (typeof source === 'string') return Buffer.from(source, 'utf8');
  if (source instanceof ArrayBuffer) return Buffer.from(source);
  return Buffer.from(source.buffer, source.byteOffset, source.byteLength);
}

/** Observe this hook's return boundary only. A later hook (for example tsx)
 * can transform these bytes; this is not the final executed runtime identity.
 * Hash the actual supplied/returned buffers, never disk or a later HEAD read. */
function auditLoad(file, result, verdict, input, returned) {
  // The channel is optional; do not hash an entire module graph when disabled.
  if (!process.env[COMMITTED_SOURCE_AUDIT_ENV]) return;
  audit({
    via: 'esm', kind: verdict.kind, file, rel: verdict.rel ?? null,
    schemaVersion: 'committed-source-load-receipt-v1', boundary: 'node-esm-load-return',
    pid: process.pid, threadId, format: result.format ?? null,
    inputSha256: createHash('sha256').update(input).digest('hex'),
    returnedSha256: returned === null ? null : createHash('sha256').update(returned).digest('hex'),
    returnedByteLength: returned === null ? null : returned.length,
    unresolved: ['later-loader-transforms-unmeasured', 'loader-self-unmeasured'],
  });
}

/** ES `load` hook (hooks thread). */
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.startsWith('file:') || result.source == null) return result;
  const file = fileURLToPath(url);
  const input = toBuffer(result.source);
  const viteVerdict = judgeViteConfigBundle(file, input);
  const verdict = viteVerdict?.verdict ?? judgeModuleBytes(file, input);
  if (viteVerdict?.refused) {
    audit({
      via: 'esm', kind: 'vite-refused', file, rel: verdict.rel ?? null,
      refused: true, reason: viteVerdict.reason,
    });
    notice({
      kind: 'refused', via: 'esm', rel: verdict.rel ?? file, top: verdict.top,
      reason: viteVerdict.reason,
    });
    throw new Error(
      `${COMMITTED_SOURCE_MARKER} refused ${verdict.rel ?? file}: Vite compiled a config from `
        + `source that is ${viteVerdict.reason === 'uncommitted-source' ? 'uncommitted' : 'different from HEAD'}`,
    );
  }
  const returned = verdict.kind === 'uncommitted' ? null :
    verdict.kind === 'substituted' ? verdict.head : input;
  auditLoad(file, result, verdict, input, returned);
  if (verdict.kind === 'uncommitted') {
    notice({ kind: 'refused', via: 'esm', rel: verdict.rel, top: verdict.top, reason: 'uncommitted' });
    throw new Error(
      `${COMMITTED_SOURCE_MARKER} refused ${verdict.rel}: it has no committed version and git does not ignore it, so it may be a held restricted write (checkout ${verdict.top})`,
    );
  }
  if (verdict.kind === 'substituted') {
    notice({ kind: 'substituted', via: 'esm', rel: verdict.rel, top: verdict.top });
    process.stderr.write(`${formatSubstitutedLine(verdict.rel, process.pid, entryLabel)}\n`);
    return { ...result, source: verdict.head };
  }
  return result;
}

/**
 * The process this loader runs in, as `initialize` received it (EI-25650771950762931). The line
 * is printed inside a launcher (`npm run test:file` runs scripts/test-files.mjs under this loader)
 * whose output also carries the test run, and a bare "the committed bytes ran" there reads as a
 * statement about the TESTS — which run in vitest processes started without this loader, from
 * working-tree bytes. Naming the process keeps the line true where it lands.
 */
let entryLabel = null;

/** ES `initialize` hook (hooks thread): receives `register`'s `data`. */
export function initialize(data) {
  entryLabel = typeof data?.entry === 'string' && data.entry ? data.entry : null;
  const pinnedGit = typeof data?.gitExecutable === 'string' && data.gitExecutable
    ? data.gitExecutable
    : process.env[COMMITTED_SOURCE_GIT_ENV];
  gitExecutable = resolveGitExecutable({
    ...process.env,
    ...(pinnedGit ? { [COMMITTED_SOURCE_GIT_ENV]: pinnedGit } : {}),
  });
}

/** The stderr line for one substituted module, scoped to the process that ran its HEAD bytes. */
export function formatSubstitutedLine(rel, pid, entry) {
  return `${COMMITTED_SOURCE_MARKER} substituted ${rel}: the working tree differs from HEAD, so the committed bytes ran `
    + `in THIS process only (pid ${pid}${entry ? `, entry ${entry}` : ''}); a process it starts without this loader `
    + `(vitest's test workers included) loads the working-tree bytes`;
}

/** The entry script, as its checkout-relative path when inside one, else its file name. */
function describeEntry(argv1) {
  if (!argv1) return null;
  try {
    const where = locate(argv1);
    if (where.place === 'checkout' || where.place === 'dependency') return where.rel;
  } catch {
    // An unreadable entry path only loses the label, never the judgement.
  }
  return argv1.split(sep).pop() || null;
}

/**
 * Judge checkout modules compiled through CommonJS (registering thread). `_compile` receives the
 * exact text about to be compiled, after every CommonJS extension hook (tsx's included) has had
 * its say, so that text is judged against the HEAD blob like an ES module's bytes are. Only an
 * exact committed match (or a git-ignored path) runs. Anything else refuses rather than
 * substituting HEAD: a mismatch here may be a dirty file OR a loader transform (tsx compiling
 * TypeScript), and raw HEAD text would bypass that transform, so fail-closed is the only safe
 * answer (WI-6554700010009021).
 */
function guardCommonJs() {
  const compile = Module.prototype._compile;
  Module.prototype._compile = function committedSourceCompile(content, filename, ...rest) {
    // Node 25 compiles its own in-memory bridge for -e/-p and stdin through
    // _compile. These exact virtual module identities have no filesystem bytes
    // to judge. Real modules (including files named [eval]-wrapper) arrive with
    // a resolved filename and must still pass the checkout CommonJS fence.
    if ((this.id === '[eval]' || this.id === '[stdin]') && filename === `${this.id}-wrapper`) {
      return compile.call(this, content, filename, ...rest);
    }
    const input = toBuffer(content);
    const viteVerdict = judgeViteConfigBundle(filename, input);
    const verdict = viteVerdict?.verdict ?? judgeModuleBytes(filename, input);
    if (viteVerdict?.refused) {
      audit({
        via: 'cjs', kind: 'vite-refused', file: filename, rel: verdict.rel ?? null,
        refused: true, reason: viteVerdict.reason,
      });
      notice({
        kind: 'refused', via: 'cjs', rel: verdict.rel ?? filename, top: verdict.top,
        reason: viteVerdict.reason,
      });
      throw new Error(
        `${COMMITTED_SOURCE_MARKER} refused ${verdict.rel ?? filename}: Vite compiled a config from `
          + `source that is ${viteVerdict.reason === 'uncommitted-source' ? 'uncommitted' : 'different from HEAD'}`,
      );
    }
    if (verdict.kind === 'outside' || verdict.kind === 'dependency') {
      return compile.call(this, content, filename, ...rest);
    }
    const refused = verdict.kind === 'substituted' || verdict.kind === 'uncommitted';
    audit({ via: 'cjs', kind: verdict.kind, file: filename, rel: verdict.rel, refused });
    if (refused) {
      notice({
        kind: 'refused', via: 'cjs', rel: verdict.rel, top: verdict.top,
        reason: verdict.kind === 'uncommitted' ? 'uncommitted' : 'differs-from-head',
      });
    }
    if (verdict.kind === 'uncommitted') {
      throw new Error(
        `${COMMITTED_SOURCE_MARKER} refused ${verdict.rel}: a checkout module loaded through CommonJS has no committed version and git does not ignore it, so it may be a held restricted write (checkout ${verdict.top})`,
      );
    }
    if (verdict.kind === 'substituted') {
      throw new Error(
        `${COMMITTED_SOURCE_MARKER} refused ${verdict.rel}: a checkout module loaded through CommonJS differs from its HEAD blob (a dirty file, or text rewritten by a CommonJS loader hook such as tsx), and CommonJS cannot safely run the committed bytes instead`,
      );
    }
    return compile.call(this, content, filename, ...rest);
  };
}

// The same file serves as the --import entry and as the hooks module; the query string marks
// the hooks-thread instance so it does not register a second time.
if (!new URL(import.meta.url).searchParams.has(HOOKS_QUERY)) {
  const hooks = new URL(import.meta.url);
  hooks.searchParams.set(HOOKS_QUERY, '1');
  // This (registering) thread's instance labels its own CommonJS notices; the hooks thread's
  // instance receives the same label through `initialize`.
  entryLabel = describeEntry(process.argv[1]);
  gitExecutable = resolveGitExecutable(process.env);
  process.env[COMMITTED_SOURCE_GIT_ENV] = gitExecutable ?? GIT_UNAVAILABLE_SENTINEL;
  register(hooks.href, { data: { entry: entryLabel, gitExecutable } });
  guardCommonJs();
}
