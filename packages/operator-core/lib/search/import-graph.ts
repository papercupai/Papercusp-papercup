/**
 * import-graph — the transitive RUNTIME import graph of a TypeScript module.
 *
 * Two guards need the same question answered — "what does importing this
 * module actually load?" — and they need it answered the same way:
 *
 *  - `configure-search-defaults-import-purity.test.ts` (D-026): the P-017 seam
 *    self-installs on import, so whatever it reaches, every `runHybridSearch`
 *    caller reaches. It must not reach a module that opens PG at import.
 *  - `search-surface-conformance.test.ts` (P-021): a surface's feature set is
 *    DERIVED from what its implementation reaches, not from what its own file
 *    happens to spell. `rubrics:search` and `cupboard:search` contain no search
 *    mechanism at all in their own file — both delegate — so a per-file grep
 *    reports "keyword-only" for surfaces it simply did not follow.
 *
 * ─── WHY STATIC, AND WHAT THAT BUYS ────────────────────────────────────────
 * The alternative (import the module and observe) is what found D-026's bug in
 * the first place, and it is strictly more truthful. It is also unusable as a
 * guard here: importing a search surface executes its module-scope code, which
 * is exactly the thing under test. A static walk is inert.
 *
 * ─── THE BOUND, STATED PLAINLY ─────────────────────────────────────────────
 * This follows RELATIVE specifiers only. Bare package specifiers
 * (`@papercusp/*`, node builtins) are RECORDED in `externals` and not
 * traversed. So a heavy module reached only through a package entrypoint is
 * invisible to the walk. That is a real hole, not a rounding error — treat a
 * negative result as "not reached through relative imports", never as "not
 * reached". Every caller that asserts an ABSENCE therefore owes a CONTROL: run
 * the same walk from a module that DOES reach the thing, and assert it is
 * found. Without that, a walker broken by a rename passes every absence
 * assertion while checking nothing.
 *
 * ⚠ GENERIC-FIRST DEFERRAL (stated, per repo convention). This algorithm is
 * domain-free and belongs in `libs/generic/`. It is here instead because
 * standing up a new workspace requires an `npm install` against the SHARED
 * tree — a fleet-visible mutation that can rewrite `node_modules/.bin` under
 * every other agent's in-flight test run — and both consumers today live in
 * this package. Promote it the moment a third consumer appears outside
 * operator-core; tracked on EI-19899318545334860.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

export interface ImportGraph {
  /** Every .ts/.tsx file reachable from the entry, EXCLUDING the entry itself. */
  modules: Set<string>;
  /** Bare specifiers seen anywhere in the graph, e.g. `@papercusp/search`. */
  externals: Set<string>;
  /** Relative specifiers that resolved to nothing — a rename, or a bug here. */
  unresolved: Array<{ from: string; specifier: string }>;
}

/**
 * Blank out comments, preserving byte offsets and newlines.
 *
 * ⚠ NOT cosmetic. This repo's modules document their own import rules IN
 * COMMENTS, so prose like `every existing \`from '../work-items'\` importer`
 * is common — and a raw regex reads it as an edge. That fails in BOTH
 * directions: it invented an unresolved specifier here on the first run, and,
 * far worse, a comment mentioning a heavy module would manufacture a false
 * reachability edge and make an absence guard report a coupling that does not
 * exist. A guard that can be tripped by a sentence is not a guard.
 *
 * String and template literals are tracked so a `//` inside a URL or a regex-
 * ish string is not mistaken for a line comment.
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let mode: Mode = 'code';
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && n === '*') { mode = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") mode = 'single';
      else if (c === '"') mode = 'double';
      else if (c === '`') mode = 'template';
      out += c;
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c; } else out += ' ';
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') { mode = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? c : ' ';
      i += 1;
      continue;
    }
    // Inside a string/template: copy verbatim, honour backslash escapes.
    if (c === '\\') { out += c + (n ?? ''); i += 2; continue; }
    if ((mode === 'single' && c === "'") || (mode === 'double' && c === '"') || (mode === 'template' && c === '`')) {
      mode = 'code';
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * The relative + bare RUNTIME import specifiers of one TS module.
 *
 * `import type` / `export type` statements are erased by the compiler and pull
 * NOTHING at runtime, so counting them would report a coupling that does not
 * exist — the difference between "this module loads PG at import" and "this
 * module mentions a PG type". An inline `{ type X, y }` still emits (it has a
 * value import), so only the statement-leading `type` keyword disqualifies a
 * statement.
 */
export function runtimeSpecifiers(file: string): string[] {
  if (file.endsWith('.json')) {
    JSON.parse(readFileSync(file, 'utf8'));
    return [];
  }
  const src = stripComments(readFileSync(file, 'utf8'));
  const out: string[] = [];
  // ⚠ TWO guards in this pattern, both earned by a false edge it produced:
  //
  //  - the negative lookahead. `export` also begins `export function`,
  //    `export const`, … — by far its commonest use. Without the lookahead,
  //    such a line starts a match and the lazy middle then scans FORWARD,
  //    across the whole file if need be, to the next `from '…'` it can find —
  //    binding an unrelated specifier (or a quoted path in prose) to it.
  //  - `[^;]*?` rather than `[\s\S]*?`. A semicolon ends the statement, so the
  //    scan cannot run past it. Multi-line `import {\n a,\n b\n} from './x'`
  //    contains no semicolon and still matches, which is the whole reason the
  //    middle has to allow newlines at all.
  //
  // Measured: with `[\s\S]*?` and no lookahead, `lib/work-items.ts` yielded a
  // phantom `../work-items` edge sourced from a doc comment ~4600 lines below
  // an `export function`. `stripComments` alone did not save it — that scanner
  // is heuristic and had desynced earlier in the file — which is the argument
  // for making the PATTERN unable to express the mistake rather than relying
  // on the input being clean.
  const withFrom =
    /(?:^|\n)[ \t]*(?:import|export)[ \t]+(?!(?:function|const|let|var|class|interface|enum|abstract|declare|default|async)\b)(type[ \t]+)?([^;]*?)from[ \t]*['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(withFrom)) {
    if (m[1]) continue; // `import type … from` / `export type … from`
    out.push(m[3]);
  }
  // Side-effect imports (`import './x';`) have no `from` clause and are always
  // runtime. This is the form that installs a policy — never skip it.
  const sideEffect = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(sideEffect)) out.push(m[1]);
  return out;
}

const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const TEST_INFRA_SEGMENTS: ReadonlySet<string> = new Set([
  'test', 'tests', '__tests__', '__fixtures__', 'fixtures', '__mocks__',
]);

/** Test infrastructure is not the proof's subject. Shared with evidence binding. */
export function isTestInfrastructurePath(repoRelative: string): boolean {
  if (TEST_FILE_RE.test(repoRelative)) return true;
  return repoRelative.split('/').slice(0, -1).some(segment => TEST_INFRA_SEGMENTS.has(segment));
}

/** Literal dynamic imports used to load a subject after vi.mock. */
function dynamicImportSpecifiers(file: string): string[] {
  const src = stripComments(readFileSync(file, 'utf8'));
  return [...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
}

/** Static runtime declarations, including adjacent imports on the same line. */
function staticRuntimeSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const specifiers = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      if (!statement.importClause?.isTypeOnly) specifiers.add(statement.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier
      && ts.isStringLiteral(statement.moduleSpecifier) && !statement.isTypeOnly) {
      specifiers.add(statement.moduleSpecifier.text);
    }
  }
  return [...specifiers];
}

function firstRingRelativeRuntimeImportPaths(root: string, testPath: string): string[] {
  const abs = resolve(root, testPath);
  const out = new Set<string>();
  for (const specifier of [...staticRuntimeSpecifiers(abs), ...dynamicImportSpecifiers(abs)]) {
    if (!specifier.startsWith('.')) continue;
    const target = resolveRelative(abs, specifier);
    if (!target) continue;
    const rel = relative(root, target);
    if (rel.startsWith('..') || isAbsolute(rel)) continue;
    const posix = rel.split(sep).join('/');
    if (posix !== testPath) out.add(posix);
  }
  return [...out].sort();
}

/** Derive proof inputs without loading tool handlers or evaluating fixture modules. */
export function deriveSubjectSourcePaths(root: string, testPath: string): string[] {
  return firstRingRelativeRuntimeImportPaths(root, testPath).filter(path => !isTestInfrastructurePath(path));
}

/** Direct first-party helpers, fixtures and mocks in the same calibrated source census. */
export function deriveFixtureSupportPaths(root: string, testPath: string): string[] {
  return firstRingRelativeRuntimeImportPaths(root, testPath).filter(isTestInfrastructurePath);
}

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a RELATIVE specifier to a concrete .ts/.tsx/.mjs/.json file, or null.
 * JSON runtime assets are validated leaves: their strings cannot create import edges.
 *
 * `.mjs` is accepted because this repo deliberately keeps a handful of shared
 * modules as plain ESM with a `.d.mts` sibling — `su-tier-roles.mjs`,
 * `model-context-budget.mjs`, `mcp-proxy/budgets.mjs`, `psu-launch-log.mjs` —
 * so that bare-`node` scripts (psu-launcher.mjs) and the TypeScript host can
 * import the SAME definition. Those are ordinary runtime imports.
 *
 * Until WI-37841 the extension filter below rejected them even though `base`
 * already WAS the real file on disk, so the first such import inside a search
 * surface's graph reported an unresolved specifier — which the conformance
 * suite correctly treats as a TRUNCATED WALK, since any "unreachable" verdict
 * computed from a graph that stopped early is unsound. Accepting `.mjs` makes
 * the walk follow them instead of stopping at them.
 */
export function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  // `.js` in a specifier is the ESM-correct spelling of a `.ts` source here.
  const stripped = base.replace(/\.js$/, '');
  for (const cand of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${stripped}.ts`,
    `${stripped}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    if (/\.(ts|tsx|mjs|json)$/.test(cand) && isFile(cand)) return cand;
  }
  return null;
}

/**
 * Walk the transitive runtime import graph from `entry`.
 *
 * `stopAt` prunes traversal INTO a module while still recording it — use it to
 * keep a walk bounded without pretending the module is absent.
 */
export function importGraph(
  entry: string,
  opts: { stopAt?: (file: string) => boolean } = {},
): ImportGraph {
  const modules = new Set<string>();
  const externals = new Set<string>();
  const unresolved: Array<{ from: string; specifier: string }> = [];
  const visited = new Set<string>([entry]);
  const queue = [entry];

  while (queue.length) {
    const file = queue.pop()!;
    for (const spec of runtimeSpecifiers(file)) {
      if (!spec.startsWith('.')) {
        externals.add(spec);
        continue;
      }
      const next = resolveRelative(file, spec);
      if (!next) {
        unresolved.push({ from: file, specifier: spec });
        continue;
      }
      modules.add(next);
      if (visited.has(next)) continue;
      visited.add(next);
      if (opts.stopAt?.(next)) continue;
      queue.push(next);
    }
  }

  modules.delete(entry);
  return { modules, externals, unresolved };
}

/** Convenience: does the runtime graph from `entry` reach `target`? */
export function reaches(entry: string, target: string): boolean {
  return importGraph(entry).modules.has(target);
}

/**
 * Calls reachable through referenced exports, separately from runtime loading.
 * Importing a module loads its initializers, but does not invoke every exported
 * function. Keep importGraph's loading contract intact; this walk selects named
 * exports and follows their local references (including callbacks). Namespace
 * imports and star re-exports are conservative. Bare packages remain outside
 * the walk, as they are for importGraph. This is static reference reachability,
 * not proof that a branch executes or that a callback is invoked.
 */
export function runtimeCallSites(entry: string, names: readonly string[]): Map<string, Set<string>> {
  const calls = new Map(names.map((name) => [name, new Set<string>()]));
  const graph = importGraph(entry);
  const files = [entry, ...graph.modules].filter((file) => !file.endsWith('.json'));
  type Binding = { file: string | null; name: string };
  type Module = {
    source: ts.SourceFile;
    locals: Map<string, ts.Node>;
    imports: Map<string, Binding>;
    exports: Map<string, string | Binding>;
    stars: string[];
  };
  const modules = new Map<string, Module>();
  const requested = new Set<string>();
  const scanned = new Set<ts.Node>();

  const moduleOf = (file: string): Module => {
    const prior = modules.get(file);
    if (prior) return prior;
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const info: Module = { source, locals: new Map(), imports: new Map(), exports: new Map(), stars: [] };
    modules.set(file, info);
    const binding = (specifier: string, name: string): Binding => ({
      file: specifier.startsWith('.') ? resolveRelative(file, specifier) : null,
      name,
    });
    const addDeclaration = (name: ts.BindingName, node: ts.Node): void => {
      if (ts.isIdentifier(name)) info.locals.set(name.text, node);
      else for (const element of name.elements) {
        if (ts.isBindingElement(element)) addDeclaration(element.name, node);
      }
    };
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const clause = statement.importClause;
        if (!clause || clause.isTypeOnly) continue;
        const specifier = statement.moduleSpecifier.text;
        if (clause.name) info.imports.set(clause.name.text, binding(specifier, 'default'));
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          info.imports.set(clause.namedBindings.name.text, binding(specifier, '*'));
        } else if (clause.namedBindings) {
          for (const element of clause.namedBindings.elements) {
            if (!element.isTypeOnly) info.imports.set(element.name.text, binding(specifier, element.propertyName?.text ?? element.name.text));
          }
        }
      } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
        const specifier = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text : null;
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            if (element.isTypeOnly) continue;
            const name = element.propertyName?.text ?? element.name.text;
            info.exports.set(element.name.text, specifier ? binding(specifier, name) : name);
          }
        } else if (specifier && statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
          info.exports.set(statement.exportClause.name.text, binding(specifier, '*'));
        } else if (specifier) {
          const target = binding(specifier, '*').file;
          if (target && !target.endsWith('.json')) info.stars.push(target);
        }
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) addDeclaration(declaration.name, declaration);
      } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
        info.locals.set(statement.name.text, statement);
      }
      if (ts.canHaveModifiers(statement)) {
        const modifiers = ts.getModifiers(statement) ?? [];
        if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
          if (ts.isVariableStatement(statement)) {
            for (const [name, node] of info.locals) {
              if (node.parent.parent === statement) info.exports.set(name, name);
            }
          } else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) {
            const isDefault = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
            if (statement.name) info.exports.set(isDefault ? 'default' : statement.name.text, statement.name.text);
            else if (isDefault) info.locals.set('default', statement);
          }
        }
      }
      if (ts.isExportAssignment(statement)) info.locals.set('default', statement.expression);
    }
    return info;
  };

  const visitBinding = (binding: Binding): void => {
    if (binding.file && !binding.file.endsWith('.json')) select(binding.file, binding.name);
  };
  const scan = (file: string, node: ts.Node, initializersOnly = false): void => {
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    if (initializersOnly && ts.isFunctionLike(node)) return;
    // A declaration may be scanned first for evaluation and later for its body.
    if (!initializersOnly) {
      if (scanned.has(node)) return;
      scanned.add(node);
    }
    const info = moduleOf(file);
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? info.imports.get(callee.text)?.name ?? callee.text
        : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      if (name && calls.has(name)) calls.get(name)!.add(file);
    }
    if (ts.isIdentifier(node)) {
      // Property names and declaration names do not reference a same-named local.
      const parent = node.parent;
      const isName = (ts.isPropertyAccessExpression(parent) && parent.name === node)
        || ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node)
        || ((ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent) || ts.isParameter(parent)) && parent.name === node);
      if (!isName) {
        const imported = info.imports.get(node.text);
        if (imported) visitBinding(imported);
        else {
          const local = info.locals.get(node.text);
          if (local) scan(file, local);
        }
      }
    }
    ts.forEachChild(node, (child) => scan(file, child, initializersOnly));
  };
  const select = (file: string, name: string): void => {
    const key = `${file}\0${name}`;
    if (requested.has(key)) return;
    requested.add(key);
    const info = moduleOf(file);
    if (name === '*') {
      for (const statement of info.source.statements) {
        if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) scan(file, statement);
      }
      for (const exported of info.exports.values()) {
        if (typeof exported === 'string') {
          const local = info.locals.get(exported);
          if (local) scan(file, local);
          else if (info.imports.has(exported)) visitBinding(info.imports.get(exported)!);
        } else visitBinding(exported);
      }
      for (const star of info.stars) select(star, '*');
      return;
    }
    const exported = info.exports.get(name) ?? name;
    if (typeof exported !== 'string') visitBinding(exported);
    else {
      const local = info.locals.get(exported);
      if (local) scan(file, local);
      else if (info.imports.has(exported)) visitBinding(info.imports.get(exported)!);
      else for (const star of info.stars) select(star, name);
    }
  };

  // Every loaded module evaluates its top-level code, regardless of the export
  // selected by its importer. Function/arrow bodies are deferred until referenced.
  for (const file of files) {
    for (const statement of moduleOf(file).source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) scan(file, statement, true);
    }
  }
  select(entry, '*');
  return calls;
}
