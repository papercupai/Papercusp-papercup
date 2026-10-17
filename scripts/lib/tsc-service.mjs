// WI-10003404 / plan host-memory-reduction-2026-09-27 P-004 — the shared typecheck service.
//
// Every scoped `lint:tsc --files=<a few files>` used to pay a whole-project compile: 17,712 files,
// 13.4 GB peak and ~29 s for operator-core, per caller. N agents checking N different files paid
// N × 13 GB, and pc-heavy could only coalesce callers whose watermark a running compile satisfied
// (measured 2026-09-27, plan decision D-003).
//
// One long-lived tsgo API server (`scripts/tsc-service/server.mjs`, socket-activated user unit)
// keeps each project's program loaded and answers a scoped request by checking only the files the
// verdict can depend on: ~1 s refresh + ~1 s check at ~5 GB, shared by every caller. The gate
// asks it first and falls back to the full CLI compile whenever it is unavailable or refuses.
//
// This module is the part both sides share: which runs are eligible, which files a scoped verdict
// needs checked, how an API diagnostic is rendered in the CLI's own text format (so the gate's
// existing parser reads service output unchanged), and the socket client.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';

/** Set to `0` to force the full CLI compile (the A/B control, and the escape hatch). */
export const TSC_SERVICE_ENV = 'PAPERCUSP_TSC_SERVICE';

/** A scoped request whose checked set exceeds this is refused; a full compile is cheaper then. */
export const TSC_SERVICE_MAX_CHECKED_FILES = Number(process.env.PAPERCUSP_TSC_SERVICE_MAX_FILES) || 1500;

/** Queue wait plus check. A refusal or timeout falls back to the CLI, so this bounds the loss. */
export const TSC_SERVICE_TIMEOUT_MS = Number(process.env.PAPERCUSP_TSC_SERVICE_TIMEOUT_MS) || 240_000;

/**
 * The unix socket the service listens on (systemd passes it pre-bound; see
 * apps/operator/scripts/systemd/papercup-tsc-service.socket, which must name the same path).
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function tscServiceSocketPath(env = process.env) {
  if (env.PAPERCUSP_TSC_SERVICE_SOCKET) return env.PAPERCUSP_TSC_SERVICE_SOCKET;
  return join(tscServiceRuntimeDir(env), 'papercusp-tsc-service.sock');
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
function tscServiceRuntimeDir(env) {
  return env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`;
}

/**
 * WI-10005362 — hosted workspace hosts run one service PER CHECKOUT. Set (by the operator, never
 * the customer) to the base name of the systemd user template units the host bootstrap installs,
 * `/etc/systemd/user/<base>@.{socket,service}`; the instance is the systemd-escaped checkout path.
 * A template, not the tower's fixed-ROOT unit, because a hosted host's checkouts are cloned under
 * its workspace root after the bootstrap ran, so the bootstrap cannot name them.
 */
export const TSC_SERVICE_UNIT_TEMPLATE_ENV = 'PAPERCUSP_TSC_SERVICE_UNIT_TEMPLATE';

/**
 * `systemd-escape --path`, so the client names the same instance the unit's `%f` resolves back to.
 * Byte-wise over UTF-8: `/` becomes `-`, a leading `.` and anything outside `[0-9A-Za-z:_.]`
 * becomes `\xNN`, and empty / `.` components are dropped first.
 *
 * @param {string} path
 * @returns {string}
 */
export function systemdEscapePath(path) {
  const simplified = path.split('/').filter((part) => part !== '' && part !== '.').join('/');
  if (simplified === '') return '-';
  const bytes = Buffer.from(simplified, 'utf8');
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    const ch = String.fromCharCode(byte);
    if (ch === '/') out += '-';
    else if ((i === 0 && ch === '.') || byte >= 0x80 || !/[0-9A-Za-z:_.]/.test(ch)) {
      out += `\\x${byte.toString(16).padStart(2, '0')}`;
    } else out += ch;
  }
  return out;
}

/**
 * The socket unit serving `root` under a template base.
 *
 * @param {string} template
 * @param {string} root
 * @returns {string}
 */
export function tscServiceTemplateSocketUnit(template, root) {
  return `${template}@${systemdEscapePath(resolve(root))}.socket`;
}

/**
 * Start (idempotently) the per-checkout socket unit and read the path systemd actually bound, so
 * the client never re-derives the unit's `ListenStream` expansion. Synchronous: two short
 * `systemctl --user` calls in the caller's own user manager, no root and no detached process.
 *
 * @param {{
 *   template: string,
 *   root: string,
 *   env?: Record<string, string | undefined>,
 *   run?: (command: string, args: string[], options: object) => { status: number | null, stdout?: string | null, stderr?: string | null, error?: Error },
 * }} opts
 * @returns {{ socketPath: string, unit: string } | { error: string, unit: string }}
 */
export function tscServiceTemplateSocket({ template, root, env = process.env, run = spawnSync }) {
  const unit = tscServiceTemplateSocketUnit(template, root);
  const options = {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...env, XDG_RUNTIME_DIR: tscServiceRuntimeDir(env) },
  };
  const started = run('systemctl', ['--user', 'start', unit], options);
  if (started.error || started.status !== 0) {
    const why = started.error?.message ?? (started.stderr ?? '').trim().split('\n').pop() ?? '';
    return { unit, error: `systemctl --user start ${unit} failed (status ${started.status}): ${why}` };
  }
  const shown = run('systemctl', ['--user', 'show', '-p', 'Listen', '--value', unit], options);
  // One `Listen=` value per line, e.g. `/run/user/1001/papercusp-tsc-service-….sock (Stream)`.
  const listen = (shown.stdout ?? '').split('\n').map((line) => line.trim()).find((line) => line.startsWith('/'));
  if (shown.status !== 0 || !listen) return { unit, error: `${unit} reports no unix socket` };
  return { unit, socketPath: unescapeSystemctlValue(listen.replace(/\s+\([A-Za-z]+\)$/, '')) };
}

/**
 * `systemctl show` C-escapes property values: the escaped instance's literal `\x2d` in the socket
 * path prints as `\\x2d` (measured, systemd 255), so the printed path is not the path on disk.
 *
 * @param {string} value
 * @returns {string}
 */
export function unescapeSystemctlValue(value) {
  const bytes = [];
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '\\' && i + 1 < value.length) {
      const next = value[i + 1];
      const hex = value.slice(i + 2, i + 4);
      if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 3;
        continue;
      }
      const simple = { '\\': 0x5c, n: 0x0a, t: 0x09, '"': 0x22, "'": 0x27 }[next];
      if (simple !== undefined) {
        bytes.push(simple);
        i += 1;
        continue;
      }
    }
    bytes.push(...Buffer.from(ch, 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * The tsconfig a gate's `tscCommand` compiles, or null when the command carries anything the
 * service does not reproduce. Deliberately a whitelist: every leg today is exactly
 * `npx tsc -p <cfg> --noEmit --incremental false`, and a new flag (say `--strict false`) would
 * change diagnostics the service cannot see, so it must fall back rather than guess.
 *
 * @param {string} tscCommand
 * @returns {string | null} the `-p` operand, as written
 */
export function serviceProjectFromTscCommand(tscCommand) {
  const tokens = String(tscCommand ?? '').trim().split(/\s+/);
  let i = 0;
  if (tokens[i] !== 'npx') return null;
  i += 1;
  if (tokens[i] === '--no-install') i += 1;
  if (tokens[i] !== 'tsc') return null;
  i += 1;
  let project = null;
  for (; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '-p' || token === '--project') {
      project = tokens[i + 1] ?? null;
      i += 1;
    } else if (token === '--incremental' || token === '--pretty') {
      if (tokens[i + 1] !== 'false') return null;
      i += 1;
    } else if (token !== '--noEmit') {
      return null;
    }
  }
  return project;
}

/**
 * Whether this gate run may ask the service. Only an explicit `--files` run qualifies: a bare
 * run, `--mine` (whose set is the whole tree's dirt), `--update` and `--seed` all need the
 * complete program and stay on the CLI, which is also faster for a full program (71 s via the
 * API vs 29 s for the CLI, measured).
 *
 * @param {{
 *   tscCommand: string,
 *   explicitFiles: Set<string> | null,
 *   argv: string[],
 *   root: string,
 *   serviceRoot?: string | null,
 *   env?: Record<string, string | undefined>,
 * }} opts
 * @returns {{ eligible: true, project: string } | { eligible: false, reason: string }}
 */
export function tscServiceEligibility({ tscCommand, explicitFiles, argv, root, serviceRoot = null, env = process.env }) {
  if (env[TSC_SERVICE_ENV] === '0') return { eligible: false, reason: `${TSC_SERVICE_ENV}=0` };
  if (explicitFiles === null || explicitFiles.size === 0) return { eligible: false, reason: 'not a --files run' };
  if (argv.includes('--update') || argv.includes('--seed')) return { eligible: false, reason: 'baseline write' };
  const project = serviceProjectFromTscCommand(tscCommand);
  if (project === null) return { eligible: false, reason: 'tscCommand has flags the service does not reproduce' };
  // The service holds ONE checkout's programs. Another checkout (the release tree, a scratch
  // copy) would open a second full program in the same 16 GB budget, so it takes the CLI.
  if (serviceRoot !== null && resolve(serviceRoot) !== resolve(root)) {
    return { eligible: false, reason: `service serves ${serviceRoot}, not ${root}` };
  }
  return { eligible: true, project: resolve(root, project) };
}

/**
 * Offsets of each line start. API diagnostic positions are UTF-16 offsets (measured: `pos` 229 for
 * an identifier at UTF-16 offset 229 / UTF-8 offset 241), so a JS string is the right unit.
 *
 * @param {string} text
 * @returns {number[]}
 */
export function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    if (ch === 13) {
      if (text.charCodeAt(i + 1) === 10) i += 1;
      starts.push(i + 1);
    } else if (ch === 10) {
      starts.push(i + 1);
    }
  }
  return starts;
}

/**
 * @param {number[]} starts
 * @param {number} pos
 * @returns {{ line: number, character: number }} both zero-based
 */
export function lineAndCharacter(starts, pos) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, character: pos - starts[lo] };
}

/**
 * @typedef {{
 *   fileName?: string,
 *   pos: number,
 *   end?: number,
 *   code: number,
 *   category: number,
 *   text: string,
 *   messageChain?: ApiDiagnostic[],
 * }} ApiDiagnostic
 */

/**
 * Render error diagnostics exactly as `tsc --pretty false` prints them:
 * `path(line,col): error TS<code>: <text>`, each message-chain level on its own line indented two
 * spaces deeper, and no related-information lines (the CLI omits those in this format). Paths are
 * relative to `root`, which is the gate's cwd, as the CLI's are.
 *
 * @param {ApiDiagnostic[]} diagnostics
 * @param {{ root: string, textFor: (fileName: string) => string | null }} opts
 * @returns {string}
 */
export function renderDiagnostics(diagnostics, { root, textFor }) {
  const startsByFile = new Map();
  const startsFor = (fileName) => {
    if (!startsByFile.has(fileName)) {
      const text = textFor(fileName);
      startsByFile.set(fileName, text === null ? null : lineStarts(text));
    }
    return startsByFile.get(fileName);
  };
  const chain = (links, depth) =>
    (links ?? []).map((link) => `\n${'  '.repeat(depth)}${link.text}${chain(link.messageChain, depth + 1)}`).join('');

  let out = '';
  for (const d of diagnostics) {
    if (d.category !== 1) continue;
    let location = '';
    if (d.fileName) {
      const starts = startsFor(d.fileName);
      const { line, character } = starts ? lineAndCharacter(starts, d.pos) : { line: 0, character: 0 };
      location = `${relative(root, d.fileName)}(${line + 1},${character + 1}): `;
    }
    out += `${location}error TS${d.code}: ${d.text}${chain(d.messageChain, 1)}\n`;
  }
  return out;
}

const IMPORT_SPECIFIER = /\b(?:from|import|require)\s*\(?\s*['"]([^'"\n]+)['"]/g;
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?|d\.[cm]?ts)$/;

/**
 * The module keys a file can be imported by: its absolute path without extension, plus its
 * directory for an `index` file.
 *
 * @param {string} absFile
 * @returns {string[]}
 */
function moduleKeysFor(absFile) {
  const bare = absFile.replace(SOURCE_EXTENSION, '');
  return bare.endsWith('/index') ? [bare, bare.slice(0, -'/index'.length)] : [bare];
}

/**
 * Whether `content` (the text of `importerAbs`) imports any of `namedKeys`. A relative specifier
 * is resolved exactly. A bare one (a package subpath or a path alias) matches when it ends with
 * the named module's last two path segments: a superset, which only costs check time.
 *
 * @param {string} content
 * @param {string} importerAbs
 * @param {Set<string>} namedKeys absolute module keys (see moduleKeysFor)
 * @param {Set<string>} namedTails `<dir>/<name>` tails of the same keys
 * @returns {boolean}
 */
export function importsAnyModule(content, importerAbs, namedKeys, namedTails) {
  IMPORT_SPECIFIER.lastIndex = 0;
  let m;
  while ((m = IMPORT_SPECIFIER.exec(content)) !== null) {
    const specifier = m[1].replace(SOURCE_EXTENSION, '');
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      if (namedKeys.has(resolve(dirname(importerAbs), specifier))) return true;
    } else {
      const segments = specifier.split('/');
      if (segments.length >= 2 && namedTails.has(segments.slice(-2).join('/'))) return true;
    }
  }
  return false;
}

/**
 * Compare a loaded project's root files with a fresh parse of its tsconfig.
 * `invalidateAll` refreshes contents and imports but does not re-evaluate include globs, so the
 * service must tell the native API about both new and removed roots explicitly.
 *
 * @param {readonly string[]} knownRootFiles
 * @param {readonly string[]} configuredRootFiles
 * @returns {{ created: string[], deleted: string[] }}
 */
export function projectRootFileChanges(knownRootFiles, configuredRootFiles) {
  const known = new Set(knownRootFiles);
  const configured = new Set(configuredRootFiles);
  return {
    created: [...configured].filter((file) => !known.has(file)),
    deleted: [...known].filter((file) => !configured.has(file)),
  };
}

/**
 * Reconcile a loaded snapshot's root files with the current tsconfig include set.
 *
 * @param {{
 *   api: {
 *     parseConfigFile(config: string): Promise<{ fileNames?: string[] }>,
 *     updateSnapshot(params: { fileChanges: { created?: string[], deleted?: string[] } }): Promise<{
 *       getProject(config: string): { rootFiles?: string[] } | undefined,
 *       dispose(): void,
 *     }>,
 *   },
 *   snapshot: {
 *     getProject(config: string): { rootFiles?: string[] } | undefined,
 *     dispose(): void,
 *   },
 *   projects: string[],
 * }} opts
 * @returns {Promise<{
 *   getProject(config: string): { rootFiles?: string[] } | undefined,
 *   dispose(): void,
 * }>}
 */
export async function refreshProjectRootFiles({ api, snapshot, projects }) {
  const created = new Set();
  const deleted = new Set();
  for (const config of projects) {
    const project = snapshot.getProject(config);
    if (!project) continue;
    const parsed = await api.parseConfigFile(config);
    const changes = projectRootFileChanges(project.rootFiles ?? [], parsed.fileNames ?? []);
    for (const file of changes.created) created.add(file);
    for (const file of changes.deleted) deleted.add(file);
  }
  if (created.size === 0 && deleted.size === 0) return snapshot;

  const fileChanges = {
    ...(created.size > 0 ? { created: [...created] } : {}),
    ...(deleted.size > 0 ? { deleted: [...deleted] } : {}),
  };
  const nextSnapshot = await api.updateSnapshot({ fileChanges });
  snapshot.dispose();
  return nextSnapshot;
}

/**
 * The files a scoped verdict about `named` depends on, drawn from the project's program:
 *
 *   - the named files themselves;
 *   - resolved importers of a named module, including aliases and transitive barrels.
 * Comments, strings and unrelated same-name declarations do not establish a dependency.
 *
 * @param {{
 *   root: string,
 *   named: Iterable<string>,
 *   programFiles: readonly string[],
 *   readText: (absFile: string) => string | null,
 *   configFile?: string,
 * }} opts
 * @returns {{ files: string[], named: number, typeReferencing: number, importers: number, namedNotInProgram: string[] }}
 */
export function checkedSetFor({ root, named, programFiles, readText, configFile }) {
  const rootPrefix = `${resolve(root)}/`;
  const namedAbs = new Set([...named].map((file) => resolve(root, file)));
  const dependent = filesDependingOnChangedModules({ root, named: namedAbs, candidates: programFiles, readText, configFile });

  const files = [];
  let namedCount = 0;
  let typeReferencing = 0;
  let importers = 0;
  const inProgram = new Set();
  for (const abs of programFiles) {
    if (!abs.startsWith(rootPrefix) || abs.includes('/node_modules/')) continue;
    inProgram.add(abs);
    if (namedAbs.has(abs)) {
      files.push(abs);
      namedCount += 1;
      continue;
    }
    if (dependent.has(abs)) {
      files.push(abs);
      importers += 1;
    }
  }
  const namedNotInProgram = [...namedAbs].filter((abs) => !inProgram.has(abs)).map((abs) => relative(root, abs));
  return { files, named: namedCount, typeReferencing, importers, namedNotInProgram };
}

/**
 * The exact named-file scope used by cross-leg consumers. Consumers only need diagnostics for the
 * requested files; reverse importers are the owning scoped verdict's responsibility. Keeping this
 * separate from checkedSetFor lets a large consumer graph reuse the loaded program without making
 * the service decline because its dependency closure exceeds the owner-check limit.
 *
 * @param {{ root: string, named: Iterable<string>, programFiles: readonly string[] }} opts
 * @returns {{ files: string[], named: number, typeReferencing: number, importers: number, namedNotInProgram: string[] }}
 */
export function namedSetFor({ root, named, programFiles }) {
  const base = resolve(root);
  const program = new Set(programFiles.map((file) => resolve(file)));
  const members = [];
  const namedNotInProgram = [];
  for (const raw of named) {
    const absolute = isAbsolute(raw) ? resolve(raw) : resolve(base, raw);
    if (program.has(absolute)) members.push(absolute);
    else namedNotInProgram.push(relative(base, absolute));
  }
  return {
    files: members,
    named: members.length,
    typeReferencing: 0,
    importers: 0,
    namedNotInProgram,
  };
}

/**
 * Shared CLI/service attribution (EI-25720784739215773). Resolve actual import/export edges
 * with TypeScript, then walk reverse edges from the changed modules. Aliases, namespace
 * imports, inferred callbacks, barrels and cycles retain provenance; comments, strings and
 * unrelated local declarations cannot invent it. No second compiler program is created.
 * Companion declarations and their executable source share a module identity.
 *
 * @param {{ root: string, named: Iterable<string>, candidates: Iterable<string>,
 *   readText?: (absFile: string) => string | null, configFile?: string }} opts
 * @returns {Set<string>} Absolute candidate paths depending on a named module.
 */
export function filesDependingOnChangedModules({ root, named, candidates, readText, configFile }) {
  const base = resolve(root);
  const inside = (file) => file.startsWith(`${base}/`) && !file.includes('/node_modules/');
  const identity = (file) => file.replace(SOURCE_EXTENSION, '');
  const targets = new Set([...named].map((file) => identity(resolve(base, file))));
  const candidateAbs = [...candidates].map((file) => resolve(base, file)).filter(inside);
  if (targets.size === 0) return new Set();
  const optionsByConfig = new Map();
  const configsByDir = new Map();
  const optionsFor = (file) => {
    const dir = dirname(file);
    if (!configsByDir.has(dir)) configsByDir.set(dir, configFile
      ? resolve(base, configFile) : ts.findConfigFile(dir, ts.sys.fileExists));
    const config = configsByDir.get(dir);
    if (!optionsByConfig.has(config)) {
      const options = config
        ? ts.parseJsonConfigFileContent(ts.readConfigFile(config, ts.sys.readFile).config ?? {},
          { ...ts.sys, readDirectory: () => [] }, dirname(config), undefined, config).options
        : { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, allowJs: true };
      optionsByConfig.set(config, { options, cache: ts.createModuleResolutionCache(base, (s) => s, options) });
    }
    return optionsByConfig.get(config);
  };
  const reverse = new Map();
  // This request-local module census grows only once per resolved repository file.
  // Set iteration visits newly resolved modules without retaining duplicate import edges.
  const moduleFiles = new Set(candidateAbs);
  for (const file of moduleFiles) {
    const text = readText ? readText(file) : ts.sys.readFile(file);
    if (text == null) continue;
    const { options, cache } = optionsFor(file);
    for (const imp of ts.preProcessFile(text, true, true).importedFiles) {
      const resolved = ts.resolveModuleName(imp.fileName, file, options, ts.sys, cache).resolvedModule;
      if (!resolved || !inside(resolved.resolvedFileName)) continue;
      const key = identity(resolved.resolvedFileName);
      if (!reverse.has(key)) reverse.set(key, new Set());
      reverse.get(key).add(identity(file));
      moduleFiles.add(resolved.resolvedFileName);
    }
  }
  const reachable = new Set(targets);
  for (const module of reachable) {
    for (const importer of reverse.get(module) ?? []) {
      reachable.add(importer);
    }
  }
  return new Set(candidateAbs.filter((file) => reachable.has(identity(file)) && !targets.has(identity(file))));
}

/**
 * A dependency is check scope, not diagnostic causality. Attribute only a diagnostic whose
 * actual or contextual type resolves to a type exported by a changed module. Binding symbols
 * preserves renamed imports and inferred callback/object fixtures without blaming unrelated
 * errors in the same importer (EI-25720784739215773).
 *
 * @param {{root: string, named: Iterable<string>, candidates: Iterable<string>,
 *   output: string, configFile?: string}} opts
 * @returns {Set<string>} Absolute diagnostic paths with changed-type provenance.
 */
export function diagnosticFilesDependingOnChangedTypes({ root, named, candidates, output, configFile }) {
  const base = resolve(root);
  const names = [...named].map((file) => resolve(base, file));
  const dependent = filesDependingOnChangedModules({ root, named: names, candidates, configFile });
  if (dependent.size === 0) return new Set();
  const config = configFile ? resolve(base, configFile) : ts.findConfigFile(base, ts.sys.fileExists);
  const configured = config ? ts.parseJsonConfigFileContent(ts.readConfigFile(config, ts.sys.readFile).config ?? {},
    { ...ts.sys, readDirectory: () => [] }, dirname(config), undefined, config).options : {};
  const options = { ...configured, noEmit: true, noLib: true, types: [], allowJs: true };
  const host = ts.createCompilerHost(options);
  // We bind the relevant repository symbols, not third-party packages or a second full check.
  const cache = ts.createModuleResolutionCache(base, (s) => s, options);
  host.resolveModuleNameLiterals = (literals, file) => literals.map((literal) => {
    const result = ts.resolveModuleName(literal.text, file, options, ts.sys, cache);
    const resolved = result.resolvedModule;
    return resolved?.resolvedFileName.startsWith(`${base}/`) && !resolved.resolvedFileName.includes('/node_modules/')
      ? result : { resolvedModule: undefined };
  });
  const program = ts.createProgram([...names, ...dependent], options, host);
  const checker = program.getTypeChecker();
  const targetKeys = new Set(names.map((file) => file.replace(SOURCE_EXTENSION, '')));
  const targets = new Set();
  const unalias = (symbol) => symbol?.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  for (const file of program.getSourceFiles()) {
    if (!targetKeys.has(file.fileName.replace(SOURCE_EXTENSION, ''))) continue;
    const module = checker.getSymbolAtLocation(file);
    if (!module) continue;
    for (const symbol of checker.getExportsOfModule(module)) {
      const original = unalias(symbol);
      if (original?.declarations?.some((d) => targetKeys.has(d.getSourceFile().fileName.replace(SOURCE_EXTENSION, ''))
        && (ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d) || ts.isClassDeclaration(d) || ts.isEnumDeclaration(d)))) targets.add(original);
    }
  }
  const carriesTarget = (type, seen = new Set()) => {
    if (!type || seen.has(type)) return false;
    seen.add(type);
    if (targets.has(unalias(type.symbol)) || targets.has(unalias(type.aliasSymbol))) return true;
    const parts = type.isUnionOrIntersection() ? type.types : [];
    const args = type.flags & ts.TypeFlags.Object && type.objectFlags & ts.ObjectFlags.Reference
      ? checker.getTypeArguments(type) : [];
    return [...parts, ...args].some((part) => carriesTarget(part, seen));
  };
  const attributed = new Set();
  for (const line of String(output).split('\n')) {
    const match = /^(.+)\((\d+),(\d+)\):\s*error TS\d+:/.exec(line);
    if (!match) continue;
    const path = resolve(base, match[1]);
    if (!dependent.has(path)) continue;
    const file = program.getSourceFile(path);
    if (!file) continue;
    // tsc judged an EARLIER snapshot of a shared, live tree; this program re-reads the file now, so
    // a diagnostic's (line, column) may no longer exist in it. getPositionOfLineAndCharacter ASSERTS
    // on an out-of-range column (TypeScript "Debug Failure. False expression." in
    // computePositionOfLineAndCharacter), and that throw crashed the whole gate (EI-25816656568127078).
    // Apply TypeScript's own bound here and skip a location this snapshot cannot hold, exactly as an
    // out-of-range line already is: the diagnostic describes text that is gone.
    const starts = file.getLineStarts();
    const lineIndex = Number(match[2]) - 1;
    const character = Number(match[3]) - 1;
    if (lineIndex < 0 || lineIndex >= starts.length || character < 0) continue;
    const pos = starts[lineIndex] + character;
    if (lineIndex + 1 < starts.length ? pos >= starts[lineIndex + 1] : pos > file.text.length) continue;
    let node = file;
    const descend = (parent) => ts.forEachChild(parent, (child) => {
      if (child.getFullStart() <= pos && pos < child.getEnd()) { node = child; descend(child); }
    });
    descend(file);
    // Diagnostic locations include the object itself, a variable name, or a nested property.
    // Stop before the surrounding function/file can lend an unrelated contextual signature.
    for (let current = node, depth = 0; current && depth < 4 && !ts.isSourceFile(current); current = current.parent, depth += 1) {
      // A named-only ImportClause has no default-binding symbol. TypeScript's
      // getTypeAtLocation handles it as a default import and dereferences that
      // missing symbol (undefined.flags). Its identifiers/specifiers are queried
      // at their own locations; the containing clause has no value type to ask for.
      if (ts.isImportClause(current) && !current.name) continue;
      const context = ts.isExpression(current) ? checker.getContextualType(current) : undefined;
      const receiver = ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)
        ? checker.getTypeAtLocation(current.expression) : undefined;
      if (carriesTarget(context) || carriesTarget(receiver) || carriesTarget(checker.getTypeAtLocation(current))) { attributed.add(path); break; }
    }
  }
  return attributed;
}

/**
 * Restrict a baseline map to the files a service run actually judged. Without this every
 * baselined file outside the checked set reads as "improved to 0" and the report lists hundreds
 * of phantom improvements.
 *
 * @param {Record<string, number>} baselineByFile
 * @param {Set<string>} judged
 * @returns {Record<string, number>}
 */
export function baselineWithinScope(baselineByFile, judged) {
  return Object.fromEntries(Object.entries(baselineByFile).filter(([file]) => judged.has(file)));
}

/**
 * @typedef {{
 *   ok: true,
 *   output: string,
 *   errorCount: number,
 *   checked: string[],
 *   counts: { named: number, typeReferencing: number, importers: number },
 *   namedNotInProgram: string[],
 *   snapshotAgeMs: number,
 *   queuedMs: number,
 *   checkMs: number,
 * } | { ok: false, reason: string, detail?: string }} TscServiceResponse
 */

/**
 * One request over the socket: a JSON line out, a JSON line back.
 *
 * @param {{ socketPath: string, request: Record<string, unknown>, timeoutMs?: number }} opts
 * @returns {Promise<TscServiceResponse>}
 */
export function requestTscService({ socketPath, request, timeoutMs = TSC_SERVICE_TIMEOUT_MS }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    const fail = (error) => {
      clearTimeout(timer);
      socket.destroy();
      rejectPromise(error);
    };
    const timer = setTimeout(() => fail(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        resolvePromise(JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        rejectPromise(error);
      }
    });
    socket.on('error', fail);
    socket.on('close', () => fail(new Error('connection closed before an answer')));
  });
}

/**
 * The gate's side: ask the service to check `files` in `project`, returning null (with the
 * reason already printed) whenever the caller must fall back to the full compile.
 *
 * Under {@link TSC_SERVICE_UNIT_TEMPLATE_ENV} the socket is this checkout's template instance,
 * started on demand; otherwise the one fixed socket of {@link tscServiceSocketPath}.
 *
 * @param {{
 *   root: string,
 *   project: string,
 *   files: string[],
 *   label: string,
 *   log?: (line: string) => void,
 *   scope?: 'dependencies' | 'named',
 *   env?: Record<string, string | undefined>,
 * }} opts
 * @returns {Promise<Extract<TscServiceResponse, { ok: true }> | null>}
 */
export async function typecheckViaService({ root, project, files, label, log = (line) => console.error(line), scope, env = process.env }) {
  let socketPath = tscServiceSocketPath(env);
  const template = env[TSC_SERVICE_UNIT_TEMPLATE_ENV];
  if (template) {
    const located = tscServiceTemplateSocket({ template, root, env });
    if ('error' in located) {
      log(`⚠ TSC_SERVICE unavailable (${located.error}) — running the full ${label} compile instead.`);
      return null;
    }
    socketPath = located.socketPath;
  }
  try {
    const response = await requestTscService({
      socketPath,
      request: { v: 1, root, project, files, ...(scope === undefined ? {} : { scope }) },
    });
    if (response.ok) return response;
    log(`⚠ TSC_SERVICE declined (${response.reason}${response.detail ? `: ${response.detail}` : ''}) — running the full ${label} compile instead.`);
  } catch (error) {
    log(`⚠ TSC_SERVICE unreachable at ${socketPath} (${error instanceof Error ? error.message : String(error)}) — running the full ${label} compile instead.`);
  }
  return null;
}

/**
 * The line a service-served run prints, so a reader knows this verdict came from the service and
 * how far it reached.
 *
 * WI-10007624: a named file this leg ROUTED to its owning leg is also, necessarily, outside this
 * project's program. Printing it under "not in this project's program" beside a `status=clean`
 * reads as a false green (a reader concluded the operator files went unchecked when the operator
 * leg had judged them). Pass the routed set, and those files get their own line saying where they
 * were judged; only files nobody judged stay on the not-in-program line.
 *
 * @param {Extract<TscServiceResponse, { ok: true }>} response
 * @param {{ routedAway?: Iterable<string> }} [opts] repo-relative files a delegate leg already judged
 * @returns {string[]}
 */
export function formatTscServiceBanner(response, { routedAway = [] } = {}) {
  const lines = [
    `TSC_SERVICE used=1 checked=${response.checked.length} named=${response.counts.named} ` +
      `typeReferencing=${response.counts.typeReferencing} importers=${response.counts.importers} ` +
      `errors=${response.errorCount} queuedMs=${response.queuedMs} checkMs=${response.checkMs} ` +
      `snapshotAgeMs=${response.snapshotAgeMs}`,
    `   (shared typecheck service: judged your files and resolved importers, including barrels ` +
      `— not the whole project. Unrelated files are judged by the bare run; ` +
      `${TSC_SERVICE_ENV}=0 forces the full compile.)`,
  ];
  const routed = new Set([...routedAway].map((file) => String(file).replace(/^\.\//, '')));
  const delegated = response.namedNotInProgram.filter((file) => routed.has(file));
  const unjudged = response.namedNotInProgram.filter((file) => !routed.has(file));
  if (unjudged.length > 0) {
    lines.push(
      `   (${unjudged.length} named file(s) are not in this project's program, as with the CLI: ` +
        `${unjudged.slice(0, 5).join(', ')}${unjudged.length > 5 ? ', …' : ''})`,
    );
  }
  if (delegated.length > 0) {
    lines.push(
      `   (${delegated.length} named file(s) belong to another project and were judged by its own leg, ` +
        `counted as filesRoutedAway: ${delegated.slice(0, 5).join(', ')}${delegated.length > 5 ? ', …' : ''})`,
    );
  }
  return lines;
}

/**
 * Read a file's text, or null when it cannot be read. The server's cached reader wraps this.
 *
 * @param {string} absFile
 * @returns {string | null}
 */
export function readTextOrNull(absFile) {
  try {
    return readFileSync(absFile, 'utf8');
  } catch {
    return null;
  }
}
