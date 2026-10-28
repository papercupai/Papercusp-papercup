#!/usr/bin/env node
/**
 * Build-time recurrence guard for EI-19521771595863238 / EI-25217214806027261.
 *
 * esbuild does not resolve identifiers the way tsc does. A TypeScript source that
 * references a name with no binding in scope (tsc: TS2304 "Cannot find name") is
 * bundled verbatim as a bare GLOBAL reference, and nothing fails until that code
 * executes. bundle-host.sh bundles the LIVE shared tree, so a peer's half-finished
 * edit (the call site written before the import, a const used outside the block
 * that declares it) is enough to publish a host that throws
 * `ReferenceError: X is not defined`. Measured twice on 2026-10-06:
 *   - 07:23Z: `loadAttributionRosterForTick` referenced outside its block scope in
 *     git-sync-action.ts; every git-sync fire on every install faulted for ~1h.
 *   - 08:23Z: `ADMISSION_RULE_SOURCE_KINDS` used in admit.ts before its import was
 *     added; bg-host crashed on boot.
 *
 * Whole-bundle scope analysis is too heavy for the boot path (acorn + eslint-scope
 * over the 66 MB host bundle: 35 s, 2.9 GB RSS). This guard instead analyses each
 * repo-owned bundle INPUT on its own, using @typescript-eslint's parser + scope
 * manager, and reports VALUE references that reach the global scope without a
 * binding the host runtime provides. By default only inputs modified after
 * `--since <file>` (the last-known-good bundle) are checked; when that file does not
 * exist, every input is checked (selection=no-baseline-full — never a silent skip,
 * WI-6554700010030641); `--all` checks every repo-owned input and is how the
 * allowlist below is calibrated.
 *
 * Exit: 0 clean · 1 free references, unreadable inputs, or a selected batch
 * with zero analyzable inputs (bundle-host refuses to publish, keeping the
 * last-known-good bundle) · 2 misuse / unreadable metafile. Parser syntax gaps remain
 * `unparsed` warnings when some selected inputs are analyzable: esbuild already
 * accepted those sources, so they are an instrument gap rather than a confirmed
 * defect. If every selected input is unparsed, coverage is inconclusive and cannot be
 * reported as clean.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import { parse } from '@typescript-eslint/typescript-estree';
import { analyze } from '@typescript-eslint/scope-manager';
import { visitorKeys } from '@typescript-eslint/visitor-keys';

export const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/**
 * Names a bundled host input may legitimately reference that are NOT own properties
 * of the Node `globalThis`. Every entry carries the reason it is provided at runtime.
 * Re-seed from a measuring `--all --json` run, never from a hand-run grep.
 */
export const RUNTIME_PROVIDED_NAMES = new Map([
  ['require', 'CommonJS wrapper / esbuild __require shim (createRequire in the host banner)'],
  ['module', 'CommonJS wrapper (esbuild __commonJS)'],
  ['exports', 'CommonJS wrapper (esbuild __commonJS)'],
  ['__filename', 'CommonJS wrapper / host banner'],
  ['__dirname', 'CommonJS wrapper / host banner'],
  // Browser-only paths of client modules the host graph inlines (measured --all,
  // 2026-10-06: window x71, location x7, document x6, PopStateEvent x1). They run
  // only behind a runtime environment check, never in the node host.
  ['window', 'browser global (client module inlined into the host graph)'],
  ['document', 'browser global (client module inlined into the host graph)'],
  ['location', 'browser global (client module inlined into the host graph)'],
  ['PopStateEvent', 'browser global (client module inlined into the host graph)'],
  // Measured --all, 2026-10-28 (WI-6554700010030641): libs/generic/papergrid/
  // kv-persist-indexeddb reaches it only after its own `typeof indexedDB` probe.
  ['indexedDB', 'browser global (client module inlined into the host graph)'],
]);

/**
 * Window globals a Playwright page callback (page.evaluate / evaluateHandle / $eval / $$eval)
 * may reference. Those callbacks are serialized into the PAGE realm and run there, never in
 * this Node process, so these names are known ONLY inside a page-callback range. Any other
 * name inside the callback (a typo, a helper that exists only in host code) is still flagged.
 * Curated, not derived: TypeScript 6 ships no lib.dom.d.ts file to read the list from. Add a
 * name when a real page callback needs it (WI-6554700010030501: requestAnimationFrame in
 * browser-session.ts waitForFrame refused every bg-host rebuild from 19:25Z to 22:30Z).
 */
export const PAGE_REALM_GLOBALS = new Set([
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback',
  'getComputedStyle', 'getSelection', 'matchMedia', 'innerWidth', 'innerHeight', 'scrollX',
  'scrollY', 'devicePixelRatio', 'screen', 'history', 'localStorage', 'sessionStorage',
  'customElements', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'DOMParser',
  'XMLSerializer', 'NodeFilter', 'Range', 'Selection', 'ShadowRoot', 'DocumentFragment', 'Text',
  'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'InputEvent', 'FocusEvent',
]);
const PAGE_REALM_CONSTRUCTOR = /^(?:HTMLElement|Element|Node|Document|HTML[A-Z]\w*Element|SVG[A-Z]\w*Element)$/;

/**
 * Known global value names: the running Node's globalThis plus RUNTIME_PROVIDED_NAMES plus `extra`.
 * @param {Iterable<string>} [extra]
 * @returns {Set<string>}
 */
export function knownGlobalNames(extra = []) {
  const names = new Set(Object.getOwnPropertyNames(globalThis));
  for (const n of RUNTIME_PROVIDED_NAMES.keys()) names.add(n);
  for (const n of extra) names.add(n);
  return names;
}

function walk(node, enter, typeDepth = 0) {
  if (!node || typeof node.type !== 'string') return;
  const inType = typeDepth > 0 || node.type === 'TSTypeQuery' || node.type === 'TSTypeReference'
    || node.type === 'TSQualifiedName' || node.type === 'TSModuleDeclaration' || node.declare === true;
  enter(node, inType);
  const keys = visitorKeys[node.type] ?? [];
  for (const key of keys) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) walk(c, enter, inType ? typeDepth + 1 : 0);
    } else if (child && typeof child === 'object') {
      walk(child, enter, inType ? typeDepth + 1 : 0);
    }
  }
}

/**
 * Free VALUE references in one source text: identifiers that resolve to no binding
 * in the file and are not known globals. `typeof X` probes and identifiers inside
 * type-only / ambient (`declare`) constructs are excluded — esbuild erases those.
 * @param {string} code
 * @param {{ jsx?: boolean, known?: Set<string> }} [options]
 * @returns {Array<{ name: string, line: number, column: number }>}
 */
export function findFreeValueReferences(code, { jsx = false, known = knownGlobalNames() } = {}) {
  const ast = parse(code, { jsx, loc: true, range: true, comment: false, errorOnUnknownASTType: false });
  const typeofArgs = new Set();
  const typeOnly = new Set();
  const browserCallbacks = [];
  walk(ast, (node, inType) => {
    if (node.type === 'UnaryExpression' && node.operator === 'typeof' && node.argument?.type === 'Identifier') {
      typeofArgs.add(node.argument);
    }
    if (inType && node.type === 'Identifier') typeOnly.add(node);
    // Playwright serializes these inline callbacks into the page realm. Their
    // DOM constructors are supplied there, not by the Node process bundling
    // this source. Keep the exception on the callback's range; call arguments
    // and surrounding host code still need real bindings.
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
      && !node.callee.computed && node.callee.property.type === 'Identifier'
      && ['evaluate', 'evaluateHandle', '$eval', '$$eval'].includes(node.callee.property.name)) {
      const receiver = node.callee.object;
      const isPage = (receiver.type === 'Identifier' && receiver.name === 'page')
        || (receiver.type === 'MemberExpression' && !receiver.computed
          && receiver.property.type === 'Identifier' && receiver.property.name === 'page');
      const callback = node.arguments[node.callee.property.name.startsWith('$') ? 1 : 0];
      if (isPage && ['ArrowFunctionExpression', 'FunctionExpression'].includes(callback?.type)) {
        browserCallbacks.push(callback.body.range);
      }
    }
  });
  const scopeManager = analyze(ast, { sourceType: 'module', lib: [], jsxPragma: null, jsxFragmentName: null });
  const found = [];
  for (const ref of scopeManager.globalScope.through) {
    if (!ref.isValueReference) continue;
    const id = ref.identifier;
    if (id.type !== 'Identifier') continue;
    if (typeofArgs.has(id) || typeOnly.has(id)) continue;
    if (known.has(id.name)) continue;
    if ((PAGE_REALM_CONSTRUCTOR.test(id.name) || PAGE_REALM_GLOBALS.has(id.name))
      && browserCallbacks.some(([start, end]) => id.range[0] >= start && id.range[1] <= end)) continue;
    found.push({ name: id.name, line: id.loc.start.line, column: id.loc.start.column + 1 });
  }
  return found;
}

/**
 * Repo-owned source inputs of an esbuild metafile, as absolute paths.
 * @param {{ inputs?: Record<string, unknown> }} metafile
 * @param {string} baseDir
 * @returns {string[]}
 */
export function repoOwnedInputs(metafile, baseDir) {
  const out = [];
  for (const key of Object.keys(metafile.inputs ?? {})) {
    if (key.includes(':')) continue; // esbuild namespaced virtual modules (e.g. `<define:...>`)
    const abs = isAbsolute(key) ? key : resolve(baseDir, key);
    if (abs.split(sep).includes('node_modules')) continue;
    if (!SOURCE_EXTENSIONS.has(extname(abs))) continue;
    out.push(abs);
  }
  return out.sort();
}

const digest = (value) => createHash('sha256').update(value).digest('hex');

/** Reuse only a successful analysis of the SAME bytes, grammar and globals.
 * EI-27247628229290204: a first private build reparsed 7,439 unchanged inputs
 * for 107s. Unlike an mtime baseline, this also works across isolated checkouts.
 * The scanner and lockfile bytes invalidate prior parser/analysis semantics;
 * Node's version invalidates the runtime globals. Storage failure is a miss.
 * This is analysis reuse, not test evidence or permission to skip an input read.
 * @param {{ directory?: string, implementation?: string, maxEntries?: number }} [options]
 */
export function createCleanInputCache({ directory = join(homedir(), '.papercusp', 'cache', 'bundle-free-refs'),
  implementation, maxEntries = 20_000 } = {}) {
  let file;
  let entries = new Map();
  try {
    const identity = implementation ?? digest(Buffer.concat([
      readFileSync(new URL(import.meta.url)),
      readFileSync(new URL('../package-lock.json', import.meta.url)),
      Buffer.from(process.version),
    ]));
    file = join(directory, `${digest(identity)}.json`);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (saved.version === 1 && Array.isArray(saved.clean)
      && saved.clean.length <= maxEntries && saved.clean.every(key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key))
      && saved.sha256 === digest(JSON.stringify(saved.clean))) entries = new Map(saved.clean.map(key => [key, true]));
  } catch { /* absent, corrupt or unavailable cache: analyse the input */ }
  const stats = { hits: 0, analyzed: 0 };
  return {
    stats,
    /** @param {string} code @param {boolean} jsx @param {Set<string>} known */
    key(code, jsx, known) { return digest(JSON.stringify([jsx, [...known].sort(), code])); },
    /** @param {string} key */
    has(key) {
      if (!entries.has(key)) return false;
      stats.hits++;
      entries.delete(key); entries.set(key, true);
      return true;
    },
    /** @param {string} key */
    remember(key) { entries.delete(key); entries.set(key, true); },
    flush() {
      if (!file) return;
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        mkdirSync(directory, { recursive: true });
        const clean = [...entries.keys()].slice(-maxEntries);
        writeFileSync(temporary, JSON.stringify({ version: 1, clean, sha256: digest(JSON.stringify(clean)) }), { mode: 0o600 });
        renameSync(temporary, file);
        // Keep concurrently active scanner versions; bound old namespaces as
        // lockfile/scanner revisions accumulate. Eviction only loses reuse.
        const versions = readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
          .map(name => ({ path: join(directory, name), at: statSync(join(directory, name)).mtimeMs }))
          .sort((a, b) => b.at - a.at);
        for (const retired of versions.slice(32)) unlinkSync(retired.path);
      } catch { /* losing reuse cannot turn a failed scan into a pass */ }
      finally { try { unlinkSync(temporary); } catch { /* renamed or never written */ } }
    },
  };
}

/**
 * @param {string[]} files
 * @param {{ known?: Set<string>, readFile?: (file: string) => string, cache?: ReturnType<typeof createCleanInputCache> }} [options]
 * @returns {{ findings: Array<{ file: string, name: string, line: number, column: number }>, unreadable: Array<{ file: string, error: string }>, unparsed: Array<{ file: string, error: string }> }}
 */
export function checkInputs(files, { known = knownGlobalNames(), readFile = (f) => readFileSync(f, 'utf8'), cache } = {}) {
  const findings = [];
  const unreadable = [];
  const unparsed = [];
  for (const file of files) {
    let code;
    try {
      code = readFile(file);
    } catch (err) {
      unreadable.push({ file, error: `unreadable: ${err?.code ?? err?.message ?? err}` });
      continue;
    }
    const ext = extname(file);
    const jsx = ext === '.tsx' || ext === '.jsx';
    const key = cache?.key(code, jsx, known);
    if (key && cache.has(key)) continue;
    if (cache) cache.stats.analyzed++;
    try {
      const references = findFreeValueReferences(code, { jsx, known });
      for (const f of references) {
        findings.push({ file, ...f });
      }
      if (key && references.length === 0) cache.remember(key);
    } catch (err) {
      unparsed.push({ file, error: String(err?.message ?? err).split('\n')[0] });
    }
  }
  return { findings, unreadable, unparsed };
}

function parseArgs(argv) {
  const opts = { allow: [], all: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--metafile') opts.metafile = next();
    else if (a === '--base-dir') opts.baseDir = next();
    else if (a === '--since') opts.since = next();
    else if (a === '--allow') opts.allow.push(next());
    // esbuild's own `--define:NAME=VALUE` arguments, passed through verbatim by
    // bundle-host.sh: esbuild substitutes NAME, so a source reference to it is bound.
    else if (a.startsWith('--define:')) opts.allow.push(a.slice('--define:'.length).split('=')[0]);
    else if (a === '--all') opts.all = true;
    else if (a === '--json') opts.json = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.metafile || !opts.baseDir) throw new Error('--metafile and --base-dir are required');
  return opts;
}

/**
 * @param {string[]} [argv]
 * @param {{ log: (line: string) => void, error: (line: string) => void }} [io]
 * @returns {number} 0 clean · 1 free references found · 2 misuse
 */
export function main(argv = process.argv.slice(2), io = { log: console.log, error: console.error }) {
  let opts;
  let metafile;
  try {
    opts = parseArgs(argv);
    metafile = JSON.parse(readFileSync(opts.metafile, 'utf8'));
  } catch (err) {
    io.error(`check-bundle-free-refs: ${err?.message ?? err}`);
    io.log('BUNDLE_FREE_REFS_RESULT status=error');
    return 2;
  }
  const inputs = repoOwnedInputs(metafile, opts.baseDir);
  let selection = 'all';
  let files = inputs;
  if (!opts.all) {
    let sinceMs = null;
    if (opts.since) {
      try {
        sinceMs = statSync(opts.since).mtimeMs;
      } catch {
        sinceMs = null;
      }
    }
    if (sinceMs === null) {
      // WI-6554700010030641: no last-known-good bundle (a first build, or a scratch
      // outdir used as a pre-restart smoke test). This used to SKIP with exit 0, which
      // is indistinguishable from a pass: a scratch build reported green over a tree
      // the live rebuild then refused. With no baseline there is no "changed since"
      // set, so the honest selection is EVERY repo-owned input (~30 s on the host
      // graph, paid only when no baseline exists). A finding refuses publication like
      // any other: shipping a bundle that throws ReferenceError is not a boot.
      selection = 'no-baseline-full';
      io.error(`ⓘ no last-known-good bundle at ${opts.since ?? '(no --since)'}; checking every repo-owned input (${inputs.length})`);
    } else {
      selection = 'changed-since-baseline';
      files = inputs.filter((f) => {
        try {
          return statSync(f).mtimeMs > sinceMs;
        } catch {
          return true;
        }
      });
    }
  }
  const t0 = Date.now();
  const known = knownGlobalNames(opts.allow);
  const cache = createCleanInputCache();
  const { findings, unreadable, unparsed } = checkInputs(files, { known, cache });
  cache.flush();
  const ms = Date.now() - t0;
  const allSelectedInputsUnparsed = files.length > 0 && unparsed.length === files.length;
  let status = 'clean';
  if (findings.length > 0 || unreadable.length > 0) status = 'refused';
  else if (allSelectedInputsUnparsed) status = 'inconclusive';
  if (opts.json) {
    io.log(JSON.stringify({ status, selection, inputs: inputs.length, checked: files.length,
      analyzed: cache.stats.analyzed, cached: cache.stats.hits, ms, findings, unreadable, unparsed }));
  } else {
    for (const f of findings) {
      io.error(`🚨 free reference \`${f.name}\` at ${f.file}:${f.line}:${f.column} — no binding in scope and not a host global; the bundle would throw ReferenceError when this runs`);
    }
    for (const u of unreadable) io.error(`🚨 could not read ${u.file}: ${u.error} — refusing to publish an input the guard could not analyze`);
    for (const u of unparsed) io.error(`⚠ could not analyse ${u.file}: ${u.error}`);
    if (allSelectedInputsUnparsed) {
      io.error('🚨 no selected inputs could be analysed; refusing to publish an inconclusive bundle scan');
    }
  }
  io.log(`BUNDLE_FREE_REFS_RESULT status=${status} selection=${selection} inputs=${inputs.length} checked=${files.length} findings=${findings.length} unreadable=${unreadable.length} unparsed=${unparsed.length} ms=${ms} analyzed=${cache.stats.analyzed} cached=${cache.stats.hits}`);
  return findings.length > 0 || unreadable.length > 0 || allSelectedInputsUnparsed ? 1 : 0;
}

// Basename pin, as in check-bundled-cli-entry-guards.mjs: bundle-host.sh runs this under
// plain node with the committed-source loader, before any bundle exists.
function isDirectCliInvocation(entryPath = process.argv[1]) {
  return typeof entryPath === 'string' && /(?:^|[\\/])check-bundle-free-refs\.mjs$/.test(entryPath);
}

if (isDirectCliInvocation()) {
  process.exitCode = main();
}
