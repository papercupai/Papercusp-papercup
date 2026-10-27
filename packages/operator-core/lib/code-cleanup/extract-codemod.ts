/**
 * Type-1/2 extraction codemod (code-cleanup-campaigns-2026-10-26 P-006; parser choice D-009).
 *
 * Given a clone family whose copies are top-level function declarations in different files, it
 * keeps one canonical copy (exported) and replaces every other copy with an import of it. It is
 * deliberately conservative — it plans an extraction only when it can show the copies are the same
 * program:
 *   - the family is `exact` or `renamed` (near/semantic copies are not equivalent by construction);
 *   - the copies' token streams are identical after consistently renaming each copy's own bindings
 *     (parameters, locals, nested declarations, the function's own name);
 *   - every identifier a copy uses but does not declare is either a global, or the same import
 *     (same imported name, same resolved module) in every copy's file. A reference to a
 *     module-local binding is refused: the canonical copy would silently use its own file's one.
 * Anything else is refused with a reason, never approximated. Edits are text splices over AST
 * ranges (untouched code keeps its formatting) and each edited file is re-parsed before the plan
 * is returned. Pure over `readFile`; `applyExtractionPlan` writes.
 */
import { posix } from 'node:path';
import ts from 'typescript';

export interface CodemodMember { path: string; line: number; symbol: string }
export interface CodemodFamily { id: string; kind: 'exact' | 'renamed' | 'near' | 'semantic'; members: readonly CodemodMember[] }
export interface FileEdit { path: string; before: string; after: string }
export type ExtractionPlan =
  | { status: 'planned'; familyId: string; canonical: CodemodMember;
    /** Every member with the end line of its declaration (feeds the executor's coverage question). */
    members: Array<CodemodMember & { endLine: number }>; edits: FileEdit[] }
  | { status: 'refused'; familyId: string; reason: string };

interface Parsed {
  member: CodemodMember; text: string; sf: ts.SourceFile; fn: ts.FunctionDeclaration;
  tokens: string[]; free: Set<string>; declared: Set<string>;
}

const refuse = (familyId: string, reason: string): ExtractionPlan => ({ status: 'refused', familyId, reason });

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind) =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some(m => m.kind === kind);

/** Names a binding pattern or identifier introduces. */
function bindingNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) { out.push(name.text); return; }
  for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
}

/** Every name the function declares inside itself, in source order, plus its own name. */
function declaredInside(fn: ts.FunctionDeclaration): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isParameter(node) || ts.isVariableDeclaration(node)) bindingNames(node.name, names);
    else if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node)
      || ts.isClassExpression(node)) && node !== fn && node.name) names.push(node.name.text);
    else if (ts.isTypeParameterDeclaration(node)) names.push(node.name.text);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn, visit);
  return names;
}

/** An identifier in a position that names a property or label, not a binding: kept verbatim. */
function isNonBindingName(id: ts.Identifier): boolean {
  const p = id.parent;
  if ((ts.isPropertyAccessExpression(p) || ts.isQualifiedName(p)) && (ts.isPropertyAccessExpression(p) ? p.name : p.right) === id) return true;
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isPropertySignature(p)
    || ts.isMethodSignature(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p) || ts.isEnumMember(p))
    && p.name === id) return true;
  if (ts.isBindingElement(p) && p.propertyName === id) return true;
  if ((ts.isLabeledStatement(p) || ts.isBreakStatement(p) || ts.isContinueStatement(p)) && p.label === id) return true;
  return false;
}

/** Shorthand `{ x }` and object destructuring `{ x }` use the name as a key too: it must match verbatim. */
function isKeyAndBinding(id: ts.Identifier): boolean {
  const p = id.parent;
  return ts.isShorthandPropertyAssignment(p) || (ts.isBindingElement(p) && !p.propertyName && ts.isObjectBindingPattern(p.parent));
}

/** Alpha-normalized token stream of the function, its free identifiers, and the names it declares. */
function fingerprint(fn: ts.FunctionDeclaration, sf: ts.SourceFile): { tokens: string[]; free: Set<string>; declared: Set<string> } {
  const own = fn.name!.text;
  const order = declaredInside(fn);
  const mapped = new Map<string, string>([[own, '$self']]);
  for (const name of order) if (!mapped.has(name)) mapped.set(name, `$${mapped.size - 1}`);
  const tokens: string[] = [];
  const free = new Set<string>();
  const walk = (node: ts.Node) => {
    // Doc comments are trivia for Type-1, and whether a copy is exported is not part of its program.
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    if (node.kind === ts.SyntaxKind.ExportKeyword && node.parent === fn) return;
    if (node === fn.name) { tokens.push('$self'); return; }
    if (ts.isIdentifier(node)) {
      if (isNonBindingName(node)) tokens.push(`name:${node.text}`);
      else if (isKeyAndBinding(node)) tokens.push(`key:${node.text}`);
      else if (mapped.has(node.text)) tokens.push(mapped.get(node.text)!);
      else { tokens.push(`free:${node.text}`); free.add(node.text); }
      return;
    }
    const children = node.getChildren(sf);
    if (!children.length) { tokens.push(`${node.kind}:${node.getText(sf)}`); return; }
    for (const child of children) walk(child);
  };
  walk(fn);
  return { tokens, free, declared: new Set(order) };
}

interface ModuleScope { locals: Set<string>; imports: Map<string, { from: string; imported: string }> }

/** Top-level declarations and imports of a file. */
function moduleScope(sf: ts.SourceFile): ModuleScope {
  const locals = new Set<string>();
  const imports = new Map<string, { from: string; imported: string }>();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.importClause) {
      const from = st.moduleSpecifier.text;
      const clause = st.importClause;
      if (clause.name) imports.set(clause.name.text, { from, imported: 'default' });
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) imports.set(nb.name.text, { from, imported: '*' });
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) imports.set(el.name.text, { from, imported: (el.propertyName ?? el.name).text });
      }
    } else if (ts.isImportEqualsDeclaration(st)) {
      locals.add(st.name.text);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) { const n: string[] = []; bindingNames(d.name, n); n.forEach(x => locals.add(x)); }
    } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st)
      || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st) || ts.isModuleDeclaration(st)) && st.name && ts.isIdentifier(st.name)) {
      locals.add(st.name.text);
    }
  }
  return { locals, imports };
}

const stripExt = (p: string) => p.replace(/\.(d\.)?[cm]?[jt]sx?$/, '');
/** A module identity comparable across files: relative specifiers resolve against the importing file. */
const moduleKey = (fromFile: string, spec: string) =>
  spec.startsWith('.') ? `file:${stripExt(posix.normalize(posix.join(posix.dirname(fromFile), spec)))}` : `pkg:${spec}`;

function relativeSpecifier(fromFile: string, toFile: string): string {
  const rel = stripExt(posix.relative(posix.dirname(fromFile), toFile));
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/** Plan a Type-1/2 extraction for one family, or say why it cannot be planned safely. */
export async function planExtraction(family: CodemodFamily, readFile: (path: string) => Promise<string | null>): Promise<ExtractionPlan> {
  const id = family.id;
  if (family.kind !== 'exact' && family.kind !== 'renamed') {
    return refuse(id, `only exact/renamed (Type-1/2) families are extracted; a ${family.kind} family's copies are not equivalent by construction`);
  }
  if (family.members.length < 2) return refuse(id, 'a family needs at least two copies');
  const files = family.members.map(m => m.path);
  if (new Set(files).size !== files.length) return refuse(id, 'two copies share a file; this codemod only extracts across files');

  const parsed: Parsed[] = [];
  for (const member of family.members) {
    const text = await readFile(member.path);
    if (text === null) return refuse(id, `cannot read ${member.path}`);
    const sf = ts.createSourceFile(member.path, text, ts.ScriptTarget.Latest, true, scriptKind(member.path));
    const decls = sf.statements.filter((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === member.symbol);
    if (!decls.length) return refuse(id, `${member.path}: ${member.symbol} is not a top-level function declaration`);
    if (decls.length > 1) return refuse(id, `${member.path}: ${member.symbol} has overloads or duplicate declarations`);
    const fn = decls[0]!;
    if (!fn.body) return refuse(id, `${member.path}: ${member.symbol} has no body`);
    if (hasModifier(fn, ts.SyntaxKind.DefaultKeyword)) return refuse(id, `${member.path}: ${member.symbol} is a default export`);
    if (hasModifier(fn, ts.SyntaxKind.DeclareKeyword)) return refuse(id, `${member.path}: ${member.symbol} is an ambient declaration`);
    parsed.push({ member, text, sf, fn, ...fingerprint(fn, sf) });
  }

  parsed.sort((a, b) => a.member.path.localeCompare(b.member.path) || a.member.line - b.member.line);
  const canon = parsed[0]!;
  const canonTokens = canon.tokens.join('\u0001');
  for (const p of parsed.slice(1)) {
    if (p.tokens.join('\u0001') !== canonTokens) {
      return refuse(id, `${p.member.path}:${p.member.symbol} differs from ${canon.member.path}:${canon.member.symbol} beyond consistent renames of its own bindings`);
    }
  }

  const scopes = new Map(parsed.map(p => [p.member.path, moduleScope(p.sf)]));
  for (const p of parsed) {
    const scope = scopes.get(p.member.path)!;
    for (const name of p.declared) {
      if (scope.locals.has(name) || scope.imports.has(name)) {
        return refuse(id, `${p.member.path}: ${p.member.symbol} declares ${name}, which also names a module-level binding; free-name analysis would be ambiguous`);
      }
    }
  }
  const canonScope = scopes.get(canon.member.path)!;
  for (const name of canon.free) {
    for (const p of parsed) {
      if (scopes.get(p.member.path)!.locals.has(name)) {
        return refuse(id, `${p.member.path}: ${p.member.symbol} references module-local ${name}; the canonical copy cannot reach every copy's ${name}`);
      }
    }
    const ci = canonScope.imports.get(name);
    for (const p of parsed.slice(1)) {
      const pi = scopes.get(p.member.path)!.imports.get(name);
      if (!ci && !pi) continue;
      if (!ci || !pi || ci.imported !== pi.imported
        || moduleKey(canon.member.path, ci.from) !== moduleKey(p.member.path, pi.from)) {
        return refuse(id, `${name} does not resolve to the same import in ${canon.member.path} and ${p.member.path}`);
      }
    }
  }
  for (const p of parsed.slice(1)) {
    const target = `file:${stripExt(p.member.path)}`;
    if ([...canonScope.imports.values()].some(i => moduleKey(canon.member.path, i.from) === target)) {
      return refuse(id, `${canon.member.path} imports ${p.member.path}; importing back would create an import cycle`);
    }
  }

  const edits: FileEdit[] = [];
  const canonName = canon.member.symbol;
  if (!hasModifier(canon.fn, ts.SyntaxKind.ExportKeyword)) {
    const at = canon.fn.getStart(canon.sf);
    edits.push({ path: canon.member.path, before: canon.text, after: `${canon.text.slice(0, at)}export ${canon.text.slice(at)}` });
  }
  for (const p of parsed.slice(1)) {
    const local = p.member.symbol;
    const spec = relativeSpecifier(p.member.path, canon.member.path);
    const importLine = `import { ${local === canonName ? canonName : `${canonName} as ${local}`} } from '${spec}';`;
    const start = p.fn.getStart(p.sf, true);
    let end = p.fn.getEnd();
    if (p.text[end] === '\r') end++;
    if (p.text[end] === '\n') end++;
    const replacement = hasModifier(p.fn, ts.SyntaxKind.ExportKeyword) ? `export { ${local} };\n` : '';
    let after = `${p.text.slice(0, start)}${replacement}${p.text.slice(end)}`;
    const lastImport = [...p.sf.statements].filter(ts.isImportDeclaration).pop();
    if (lastImport && lastImport.getEnd() <= start) {
      const at = lastImport.getEnd();
      after = `${after.slice(0, at)}\n${importLine}${after.slice(at)}`;
    } else {
      after = `${importLine}\n${after}`;
    }
    edits.push({ path: p.member.path, before: p.text, after });
  }

  for (const e of edits) {
    const out = ts.transpileModule(e.after, { fileName: e.path, reportDiagnostics: true,
      compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.Latest } });
    if (out.diagnostics?.length) {
      return refuse(id, `the edited ${e.path} does not parse: ${ts.flattenDiagnosticMessageText(out.diagnostics[0]!.messageText, ' ')}`);
    }
  }

  return {
    status: 'planned', familyId: id, canonical: canon.member, edits,
    members: parsed.map(p => ({ ...p.member, endLine: p.sf.getLineAndCharacterOfPosition(p.fn.getEnd()).line + 1 })),
  };
}

/**
 * Write a planned extraction. Refuses (writing nothing) if any file changed since it was planned,
 * so a peer's concurrent edit is never overwritten.
 */
export async function applyExtractionPlan(plan: ExtractionPlan, io: {
  readFile(path: string): Promise<string | null>; writeFile(path: string, text: string): Promise<void>;
}): Promise<{ written: string[] }> {
  if (plan.status !== 'planned') throw new Error(`cannot apply a refused plan: ${plan.reason}`);
  for (const e of plan.edits) {
    if ((await io.readFile(e.path)) !== e.before) throw new Error(`${e.path} changed since the extraction was planned`);
  }
  for (const e of plan.edits) await io.writeFile(e.path, e.after);
  return { written: plan.edits.map(e => e.path) };
}
