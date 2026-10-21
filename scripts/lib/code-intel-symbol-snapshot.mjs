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
const sourceFile = path => /\.(?:[cm]?[jt]sx?)$/.test(path) && !path.split('/').some(p => ['node_modules', '_retired', '.materialized'].includes(p));
const add = (map, name, values) => {
  const set = map.get(name) ?? new Set();
  for (const value of values) set.add(value);
  map.set(name, set);
};
const identifiers = node => ts.isIdentifier(node) ? [node.text] : ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)
  ? node.elements.flatMap(part => ts.isBindingElement(part) ? identifiers(part.name) : []) : [];

/** Inputs are the exact tracked source cohort and resolver already used by dependency edges.
 * @param {{ files: string[], readSource: (path: string) => string | null, resolveModule: (importer: string, specifier: string) => string | null, workspacePackages?: Array<[string, string[]]> }} input
 */
export function buildSymbolSnapshot({ files, readSource, resolveModule, workspacePackages = [] }) {
  const units = new Map();
  const symbols = new Map();
  const workspaces = workspacePackages.flatMap(([name, dirs]) => dirs.map(dir => ({ name, dir })))
    .sort((a, b) => b.dir.length - a.dir.length);
  const stats = { files: 0, skippedFiles: 0, unresolvedCalls: 0, resolvedCalls: 0, truncated: false };
  for (const path of files) {
    if (!sourceFile(path)) continue;
    const text = readSource(path);
    if (text === null || Buffer.byteLength(text) > 2_000_000) { stats.skippedFiles++; continue; }
    const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    if (ast.parseDiagnostics.length) { stats.skippedFiles++; continue; }
    const sha256 = hash(text);
    const workspace = workspaces.find(entry => path.startsWith(entry.dir + '/'));
    const manifest = workspace ? manifestProof(workspace.dir + '/package.json', readSource(workspace.dir + '/package.json')) : null;
    const unit = { path, sha256, workspace, manifest, locals: new Map(), imports: new Map(), exports: new Map(), reexports: [], stars: [], shadows: new Set(), calls: [] };
    const site = node => { const at = ast.getLineAndCharacterOfPosition(node.getStart(ast)); return { path, line: at.line + 1, column: at.character + 1, sha256 }; };
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
      for (const decl of declarations) {
        if (!decl.name || !ts.isIdentifier(decl.name) || !(ts.isVariableDeclaration(decl) || ts.isFunctionDeclaration(decl)
          || ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl) || ts.isEnumDeclaration(decl))) continue;
        // Overload signatures without bodies are not separate definitions.
        if (ts.isFunctionDeclaration(decl) && !decl.body) continue;
        const name = decl.name.text;
        const location = site(decl.name);
        const id = `${path}:${location.line}:${name}`;
        const symbol = { id, name, ...location, signature: text.slice(decl.getStart(ast), decl.body?.getStart(ast) ?? Math.min(decl.end, decl.getStart(ast) + 300)).slice(0, 300), callers: [], aliases: [], sources: new Map([[path, { path, sha256 }]]) };
        symbols.set(id, symbol);
        add(unit.locals, name, [id]);
        if (exported) add(unit.exports, isDefault ? 'default' : name, [id]);
      }
    }
    const walk = node => {
      if ((ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isBindingElement(node)
        || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
        const top = ast.statements.some(statement => statement === node || ts.isVariableStatement(statement) && statement.declarationList.declarations.includes(node));
        if (!top) for (const name of identifiers(node.name)) unit.shadows.add(name);
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const expression = node.expression;
        if (ts.isIdentifier(expression)) unit.calls.push({ local: expression.text, ...site(expression) });
        else if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression))
          unit.calls.push({ local: expression.expression.text, member: expression.name.text, ...site(expression.name) });
        else stats.unresolvedCalls++;
      }
      ts.forEachChild(node, walk);
    };
    walk(ast); units.set(path, unit); stats.files++;
  }
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
    if (symbol) {
      symbol.sources.set(unit.path, { path: unit.path, sha256: unit.sha256 });
      if (unit.manifest !== null) symbol.sources.set(unit.manifest.path, unit.manifest);
      if (!symbol.aliases.includes(name)) symbol.aliases.push(name);
    }
  }
  for (const unit of units.values()) for (const call of unit.calls) {
    if (unit.shadows.has(call.local)) { stats.unresolvedCalls++; continue; }
    const binding = unit.imports.get(call.local);
    const values = call.member
      ? binding?.name === '*' ? units.get(binding.target)?.exports.get(call.member) : null
      : unit.locals.get(call.local) ?? imported(binding);
    if (!values || values.size !== 1) { stats.unresolvedCalls++; continue; }
    const symbol = symbols.get([...values][0]);
    if (!symbol || !visible.has(symbol.id)) continue;
    if (symbol.callers.length >= 500) { stats.truncated = true; continue; }
    symbol.callers.push({ path: call.path, line: call.line, column: call.column, sha256: call.sha256,
      workspace: unit.workspace ? `${unit.workspace.name} (${unit.workspace.dir})` : null,
      spelling: call.member ?? call.local }); stats.resolvedCalls++;
    symbol.sources.set(unit.path, { path: unit.path, sha256: unit.sha256 });
    if (unit.manifest !== null) symbol.sources.set(unit.manifest.path, unit.manifest);
  }
  return { schema: 'code-intel-symbol-snapshot-v1', knowledge: 'syntax-bound',
    limitations: ['JS/TS tracked parseable files only.', 'Dynamic dispatch, shadowed bindings, external packages and unresolved imports are unknown; counts are lower bounds.',
      'No runtime execution or compiler type-resolution is asserted.'], stats,
    symbols: [...symbols.values()].filter(symbol => visible.has(symbol.id)).map(symbol => ({ ...symbol,
      sources: [...symbol.sources.values()] })).sort((a, b) => a.id.localeCompare(b.id)) };
}

/** Reuse the dependency producer's resolver by deriving one synthetic import through it. */
export function relativeSymbolModule(importer, specifier, fileSet) {
  if (!specifier.startsWith('.')) return null;
  for (const candidate of baseCandidates(posix.normalize(posix.join(posix.dirname(importer), specifier))))
    if (fileSet.has(candidate)) return candidate;
  return null;
}
