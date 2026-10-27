/** Extend the maintained source snapshot with conservative, syntax-bound JS/TS calls.
 * No compiler daemon, project typecheck, external package reads, or runtime claims.
 * Dynamic dispatch and any file with a shadowed binding remain unassigned.
 */
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { baseCandidates } from './graph-dependency-suggestions.mjs';
import { PACKAGE_NAME_PROOF_DIGEST, packageNameProofSha256 } from '@papercusp/operator-core/lib/code-intelligence/proof-digest';

const hash = text => createHash('sha256').update(text).digest('hex');
/** A workspace manifest proof pins only `name` (proof-digest.ts); unparseable text keeps a full-content pin. */
const manifestProof = (path, text) => {
  if (text === null) return null;
  const nameSha256 = packageNameProofSha256(text);
  return nameSha256 === null ? { path, sha256: hash(text) } : { path, sha256: nameSha256, digest: PACKAGE_NAME_PROOF_DIGEST };
};
/** The maintained parser eligibility rule, shared with partition accounting.
 * @param {string} path
 */
export const isSymbolSnapshotSourcePath = path => /\.(?:[cm]?[jt]sx?)$/.test(path) && !path.split('/').some(p => ['node_modules', '_retired', '.materialized'].includes(p));
const add = (map, name, values) => {
  const set = map.get(name) ?? new Set();
  for (const value of values) set.add(value);
  map.set(name, set);
};
const identifiers = node => ts.isIdentifier(node) ? [node.text] : ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)
  ? node.elements.flatMap(part => ts.isBindingElement(part) ? identifiers(part.name) : []) : [];

/** Inputs are the exact tracked source cohort and resolver already used by dependency edges.
 * `censusOnly` retains resolution and completeness guards while omitting brief
 * proof objects that the source-population collector does not consume.
 * @param {{ files: string[], readSource: (path: string) => string | null, resolveModule: (importer: string, specifier: string) => string | null, workspacePackages?: Array<[string, string[]]>, includeCallCensus?: boolean, censusOnly?: boolean, callCensusSink?: (call: {path: string, line: number, column: number}, targetPath: string | null, index: number) => void }} input
 */
export function parseSymbolSnapshot({ files, readSource, resolveModule, workspacePackages = [], includeCallCensus = false, censusOnly = false }) {
  includeCallCensus ||= censusOnly;
  const units = new Map();
  const symbols = new Map();
  /** Optional measurement population; does not enlarge the ordinary brief snapshot. */
  const callCensus = [];
  const workspaces = workspacePackages.flatMap(([name, dirs]) => dirs.map(dir => ({ name, dir })))
    .sort((a, b) => b.dir.length - a.dir.length);
  const stats = { files: 0, skippedFiles: 0, unresolvedCalls: 0, resolvedCalls: 0, truncated: false };
  for (const path of files) {
    if (!isSymbolSnapshotSourcePath(path)) continue;
    const text = readSource(path);
    if (text === null || Buffer.byteLength(text) > 2_000_000) { stats.skippedFiles++; continue; }
    // No resolver operation uses parent pointers. Avoid an extra full-tree
    // parent traversal and retain only the syntax needed by the existing walk.
    const ast = ts.createSourceFile(path, text, { languageVersion: ts.ScriptTarget.Latest,
      jsDocParsingMode: ts.JSDocParsingMode.ParseNone }, false);
    if (ast.parseDiagnostics.length) { stats.skippedFiles++; continue; }
    const sha256 = censusOnly ? null : hash(text);
    const workspace = censusOnly ? null : workspaces.find(entry => path.startsWith(entry.dir + '/'));
    const manifest = workspace ? manifestProof(workspace.dir + '/package.json', readSource(workspace.dir + '/package.json')) : null;
    const unit = { path, sha256, workspace, manifest, locals: new Map(), imports: new Map(), exports: new Map(), reexports: [], stars: [], shadows: new Set(), calls: [], censusCalls: [], censusNames: [] };
    const nameIds = new Map();
    const nameId = name => {
      let id = nameIds.get(name);
      if (id === undefined) { id = unit.censusNames.length; nameIds.set(name, id); unit.censusNames.push(name); }
      return id;
    };
    const site = node => { const at = ast.getLineAndCharacterOfPosition(node.getStart(ast)); return censusOnly
      ? { path, line: at.line + 1, column: at.character + 1 }
      : { path, line: at.line + 1, column: at.character + 1, sha256 }; };
    // Retain compact numeric sites and interned spellings during the parse.
    // Full call rows are needed only after every file's exports are known.
    const pendingCall = (node, local, member) => {
      const at = ast.getLineAndCharacterOfPosition(node.getStart(ast));
      if (censusOnly) unit.censusCalls.push(nameId(local), member === undefined ? -1 : nameId(member), at.line + 1, at.character + 1);
      else unit.calls.push({ local, member, path, line: at.line + 1, column: at.character + 1, sha256 });
    };
    const topDeclarations = new Set(ast.statements);
    for (const node of ast.statements) {
      const exported = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
      const isDefault = node.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword);
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const target = resolveModule(path, node.moduleSpecifier.text);
        const clause = node.importClause;
        if (clause?.name) unit.imports.set(clause.name.text, { target, name: 'default' });
        if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings))
          unit.imports.set(clause.namedBindings.name.text, { target, name: '*' });
        else if (clause?.namedBindings) for (const part of clause.namedBindings.elements)
          unit.imports.set(part.name.text, { target, name: (part.propertyName ?? part.name).text });
      }
      if (ts.isExportDeclaration(node)) {
        const target = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? resolveModule(path, node.moduleSpecifier.text) : path;
        if (!node.exportClause && target) unit.stars.push(target);
        else if (node.exportClause && ts.isNamedExports(node.exportClause)) for (const part of node.exportClause.elements)
          unit.reexports.push({ name: part.name.text, target, from: (part.propertyName ?? part.name).text, local: !node.moduleSpecifier });
      }
      const declarations = ts.isVariableStatement(node) ? node.declarationList.declarations : [node];
      for (const decl of declarations) topDeclarations.add(decl);
      for (const decl of declarations) {
        if (!decl.name || !ts.isIdentifier(decl.name) || !(ts.isVariableDeclaration(decl) || ts.isFunctionDeclaration(decl)
          || ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl) || ts.isEnumDeclaration(decl))) continue;
        // Overload signatures without bodies are not separate definitions.
        if (ts.isFunctionDeclaration(decl) && !decl.body) continue;
        const name = decl.name.text;
        const location = site(decl.name);
        const id = `${path}:${location.line}:${name}`;
        const symbol = censusOnly ? { id, path, callerCount: 0 }
          : { id, name, ...location, signature: text.slice(decl.getStart(ast), decl.body?.getStart(ast) ?? Math.min(decl.end, decl.getStart(ast) + 300)).slice(0, 300), callers: [], aliases: [], sources: new Map([[path, { path, sha256 }]]) };
        symbols.set(id, symbol);
        add(unit.locals, name, [id]);
        if (exported) add(unit.exports, isDefault ? 'default' : name, [id]);
      }
    }
    const walk = node => {
      if ((ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isBindingElement(node)
        || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
        if (!topDeclarations.has(node)) for (const name of identifiers(node.name)) unit.shadows.add(name);
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const expression = node.expression;
        if (ts.isIdentifier(expression)) pendingCall(expression, expression.text);
        else if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression))
          pendingCall(expression.name, expression.expression.text, expression.name.text);
        else { stats.unresolvedCalls++; if (includeCallCensus) callCensus.push(site(expression)); }
      }
      ts.forEachChild(node, walk);
    };
    walk(ast); units.set(path, unit); stats.files++;
  }
  return { units, symbols, stats, immediateCalls: callCensus };
}

/** Resolve only after the complete, ordered file population is assembled.
 * Parsing can run in bounded threads without resolving against partial exports.
 * @param {Parameters<typeof parseSymbolSnapshot>[0] & { callCensusSink?: (call: {path: string, line: number, column: number}, targetPath: string | null, index: number) => void, parsed?: ReturnType<typeof parseSymbolSnapshot> }} input
 */
export function buildSymbolSnapshot(input) {
  const { censusOnly = false, callCensusSink } = input;
  const includeCallCensus = input.includeCallCensus || censusOnly;
  const { units, symbols, stats, immediateCalls } = input.parsed ?? parseSymbolSnapshot(input);
  const callCensus = [];
  let censusCount = 0;
  const recordCall = (call, target) => {
    if (!includeCallCensus) return;
    const index = censusCount++;
    if (callCensusSink) callCensusSink(call, target?.path ?? null, index);
    else callCensus.push({ id: `${call.path}:${call.line}:${call.column}:${index}`,
      from: call.path, to: target?.path ?? null, resolved: !!target });
  };
  for (const call of immediateCalls) recordCall(call, null);
  const imported = binding => binding?.target ? units.get(binding.target)?.exports.get(binding.name) ?? new Set() : new Set();
  // Resolve aliases/re-exports to a fixed point; cycles never produce invented symbols.
  for (let pass = 0; pass < 32; pass++) {
    let changed = false;
    for (const unit of units.values()) {
      const before = [...unit.exports.values()].reduce((n, set) => n + set.size, 0);
      for (const entry of unit.reexports) {
        const values = entry.local ? unit.locals.get(entry.from) ?? imported(unit.imports.get(entry.from)) : units.get(entry.target)?.exports.get(entry.from);
        if (values) add(unit.exports, entry.name, values);
      }
      const explicit = new Set([...unit.locals.keys(), ...unit.reexports.map(entry => entry.name)]);
      for (const target of unit.stars) for (const [name, values] of units.get(target)?.exports ?? [])
        if (name !== 'default' && !explicit.has(name)) add(unit.exports, name, values);
      changed ||= before !== [...unit.exports.values()].reduce((n, set) => n + set.size, 0);
    }
    if (!changed) break;
    if (pass === 31) stats.truncated = true;
  }
  const visible = new Set();
  for (const unit of units.values()) for (const [name, values] of unit.exports) for (const id of values) {
    visible.add(id);
    const symbol = symbols.get(id);
    if (symbol && !censusOnly) {
      symbol.sources.set(unit.path, { path: unit.path, sha256: unit.sha256 });
      if (unit.manifest !== null) symbol.sources.set(unit.manifest.path, unit.manifest);
      if (!symbol.aliases.includes(name)) symbol.aliases.push(name);
    }
  }
  function* pendingCalls(unit) {
    if (!censusOnly) { yield* unit.calls; return; }
    const data = unit.censusCalls, names = unit.censusNames;
    for (let i = 0; i < data.length; i += 4) yield { path: unit.path, local: names[data[i]],
      member: data[i + 1] < 0 ? undefined : names[data[i + 1]], line: data[i + 2], column: data[i + 3] };
  }
  for (const unit of units.values()) {
    for (const call of pendingCalls(unit)) {
      if (unit.shadows.has(call.local)) { stats.unresolvedCalls++; recordCall(call, null); continue; }
      const binding = unit.imports.get(call.local);
      const values = call.member
        ? binding?.name === '*' ? units.get(binding.target)?.exports.get(call.member) : null
        : unit.locals.get(call.local) ?? imported(binding);
      if (!values || values.size !== 1) { stats.unresolvedCalls++; recordCall(call, null); continue; }
      const symbol = symbols.get([...values][0]);
      recordCall(call, symbol);
      if (!symbol || !visible.has(symbol.id)) continue;
      if (censusOnly) {
        if (symbol.callerCount >= 500) { stats.truncated = true; continue; }
        symbol.callerCount++; stats.resolvedCalls++; continue;
      }
      if (symbol.callers.length >= 500) { stats.truncated = true; continue; }
      symbol.callers.push({ path: call.path, line: call.line, column: call.column, sha256: call.sha256,
        workspace: unit.workspace ? `${unit.workspace.name} (${unit.workspace.dir})` : null,
        spelling: call.member ?? call.local }); stats.resolvedCalls++;
      symbol.sources.set(unit.path, { path: unit.path, sha256: unit.sha256 });
      if (unit.manifest !== null) symbol.sources.set(unit.manifest.path, unit.manifest);
    }
    // Resolved output no longer needs the syntax records; release each file's
    // pending population before constructing the rest of the full census.
    unit.calls = [];
    unit.censusCalls = []; unit.censusNames = [];
  }
  return { schema: 'code-intel-symbol-snapshot-v1', knowledge: 'syntax-bound',
    ...(includeCallCensus ? { callCensus } : {}),
    limitations: ['JS/TS tracked parseable files only.', 'Dynamic dispatch, shadowed bindings, external packages and unresolved imports are unknown; counts are lower bounds.',
      'No runtime execution or compiler type-resolution is asserted.'], stats,
    symbols: censusOnly ? [] : [...symbols.values()].filter(symbol => visible.has(symbol.id)).map(symbol => ({ ...symbol,
      sources: [...symbol.sources.values()] })).sort((a, b) => a.id.localeCompare(b.id)) };
}

/** Reuse the dependency producer's resolver by deriving one synthetic import through it. */
export function relativeSymbolModule(importer, specifier, fileSet) {
  if (!specifier.startsWith('.')) return null;
  for (const candidate of baseCandidates(posix.normalize(posix.join(posix.dirname(importer), specifier))))
    if (fileSet.has(candidate)) return candidate;
  return null;
}
