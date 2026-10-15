/**
 * `graph:query { op:'callers' }` from the first-party backend (WI-10006543).
 *
 * Plan `gitnexus-deterministic-integration-2026-10-05`, D-026: the vendored
 * TypeScript's call hierarchy is the graph backend of record. This module answers
 * "who calls NAME" from it, scoped so a single query costs seconds, not the
 * 13.9 GiB whole-tree program the bench built.
 *
 * ── How one question is answered ───────────────────────────────────────────
 *  1. CANDIDATES. `rg -l -w -F NAME` over source files. A file that does not
 *     contain the word cannot call it, so this is the search space grep itself
 *     answers from. ripgrep's defaults apply: gitignored, hidden and
 *     node_modules paths are not searched.
 *  2. PROGRAM. A LanguageService rooted at the candidates; every other source
 *     file is reduced to its re-export statements (typescript-service.ts
 *     `reExportStub`, which documents why that is enough and how it was measured).
 *  3. RESOLVED callers. The call hierarchy into EVERY declaration named NAME,
 *     unioned. grep never chooses between same-named symbols, so neither does
 *     this: there is no "ambiguous" refusal. Each site is a call line.
 *  4. UNATTRIBUTED calls. Every syntactic `NAME(…)`, `x.NAME(…)` or
 *     `new NAME(…)` in a candidate file that step 3 did not cover, with the
 *     checker's reason: it resolves outside the repo (a default-lib or package
 *     declaration), elsewhere in the repo, or not at all (an untyped receiver,
 *     JS). These are the call lines a grep finds that a pure call graph drops.
 *     Listing them is what makes an empty answer mean what grep's absence
 *     means: no call to NAME in any searched source file.
 *
 * Comments, strings and the declarations themselves are not calls, so they are
 * not sites. That is the one way this answer is deliberately narrower than grep.
 *
 * Pure and synchronous over the file system. It blocks for seconds, so the
 * operator runs it off the main thread (first-party-callers-offthread.ts).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants as fsConstants, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, extname, isAbsolute, join, relative } from 'node:path';
import type * as TsModule from 'typescript';
import { unmeasuredSourceEvidence, versionedSymbolIdentity, type CodeIntelAnswer, type CodeIntelRelationshipKind, type CodeIntelSourceEvidence, type CodeIntelSourceFile, type SymbolSite } from './contracts.ts';
// Explicit `.ts`: the off-thread worker runs this graph under Node's native type
// stripping, which resolves no extension-less relative import.
import {
  incomingCallSites,
  hierarchyItems,
  isExternalPath,
  openScopedTsTree,
  tsDeclarations,
  tsSiteOf,
  type Ts,
  type TsDeclaration,
  type TsTree,
} from './typescript-service.ts';
import { compilerDiscovery, compilerTraversal, traversalSourceFiles } from './first-party-traversal.ts';

/** ripgrep glob for every extension the program takes (typescript-service TS_TREE_EXTENSIONS). */
export const FIRST_PARTY_SOURCE_GLOB = '*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}';

/** A name this backend can ask about: one JavaScript identifier. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Default cap on returned sites. Matches the facade budget graph:query documents. */
export const FIRST_PARTY_CALLERS_DEFAULT_LIMIT = 500;

/** How an unattributed call resolves, as the checker sees it. */
export type UnattributedReason = 'external' | 'other-in-repo' | 'unresolved';

export interface FirstPartyCallersAttribution {
  /** Sites the call hierarchy links to a declaration named NAME. */
  readonly resolved: number;
  /** Syntactic calls the hierarchy did not cover, by checker reason. */
  readonly unattributed: Readonly<Record<UnattributedReason, number>>;
  /** Every declaration named NAME the resolved set unions over (capped at 50). */
  readonly declarations: readonly SymbolSite[];
  readonly declarationCount: number;
  /** Source files containing NAME as a word: the program's root files. */
  readonly candidateFiles: number;
  /** Other in-repo files the program reached, served as re-export stubs. */
  readonly stubbedFiles: number;
}

export interface FirstPartyCallersAnswer extends CodeIntelAnswer {
  readonly attribution: FirstPartyCallersAttribution | null;
  readonly interfaces?: CompilerInterfaceEvidence;
}

export interface CompilerInterfaceEvidence {
  readonly status: 'measured' | 'unknown';
  readonly diagnostics: readonly { site: SymbolSite; code: number; message: string }[];
  readonly registrations: readonly { name: string | null; kind: 'tool' | 'route' | 'unknown'; method: string | null; path: string | null;
    factoryAuthority: 'maintained-import' | 'maintained-source' | 'unverified'; factory: SymbolSite | null;
    site: SymbolSite; implementation: SymbolSite | null;
    requestValidator: SymbolSite | null; responseValidator: SymbolSite | null; documentation: SymbolSite | null;
    requestFields?: readonly { name: string; type: string; optional: boolean }[] | null;
    responseFields?: readonly { name: string; type: string; optional: boolean }[] | null;
    runtimeRegistered: 'unmeasured' }[];
  readonly sources: readonly CodeIntelSourceFile[];
  /** Static contract candidates, never proof of executed transport or middleware. */
  readonly interactions?: readonly { protocol: 'http' | 'rpc' | 'event'; role: 'producer' | 'consumer';
    key: string | null; method: string | null; site: SymbolSite; handler: SymbolSite | null;
    authority: 'compiler-global' | 'maintained-import' | 'syntax'; middleware: 'unknown'; runtimeExecution: 'unknown' }[];
  readonly truncated: boolean;
  readonly limitations: readonly string[];
}

export interface FirstPartyCallersQuery {
  readonly ts: Ts;
  /** Absolute repository root; site paths are relative to it. */
  readonly root: string;
  /** Registry identity when the dispatching repository registry supplies one. */
  readonly repositoryId?: string;
  readonly name: string;
  /** Native graph operations share the existing bounded compiler worker. */
  readonly op?: 'callers' | 'symbol' | 'callees' | 'context' | 'impact' | 'trace' | 'contracts' | 'communities' | 'flows' | 'concept-search';
  readonly filePath?: string;
  readonly line1?: number;
  readonly kind?: string;
  readonly target?: string;
  readonly targetFilePath?: string;
  readonly targetLine1?: number;
  readonly direction?: 'upstream' | 'downstream' | 'both';
  readonly maxDepth?: number;
  readonly maxPaths?: number;
  readonly limit?: number;
  /** Reuse this worker's typed program for bounded interface diagnostics and static tool links. */
  readonly includeInterfaces?: boolean;
  /** Context only: full cited files, with reached dependencies represented as re-export stubs. */
  readonly contextScope?: 'cited-files';
  /** Already-authorized registry roots; every compiler source/config read is confined to this cohort. */
  readonly authorizedReadRoots?: readonly string[];
  /**
   * Repository-relative files or directories to search (WI-10006543). Default: the
   * whole repository. A grep over `packages/x/lib apps/y/bin` asks about those roots
   * only; answering it repo-wide costs a program over every file that names a common
   * identifier (`fetch`: 2,578 files exhausted the worker's heap).
   */
  readonly paths?: readonly string[];
  /** ripgrep binary. Default: {@link resolveRipgrep}. */
  readonly rgPath?: string;
  readonly now?: () => number;
}

/** At most this many search roots per question. */
export const FIRST_PARTY_CALLERS_MAX_PATHS = 50;

/**
 * Normalise caller-supplied search roots: repository-relative, existing, and never
 * outside the repository. Returns the roots to hand ripgrep, or why they cannot be
 * searched. An empty or absent list means the whole repository.
 */
export function resolveSearchPaths(
  root: string,
  paths: readonly string[] | undefined,
): { ok: true; paths: string[]; scoped: boolean } | { ok: false; error: string } {
  if (!paths || paths.length === 0) return { ok: true, paths: ['.'], scoped: false };
  if (paths.length > FIRST_PARTY_CALLERS_MAX_PATHS) {
    return { ok: false, error: `callers takes at most ${FIRST_PARTY_CALLERS_MAX_PATHS} paths; got ${paths.length}` };
  }
  const out: string[] = [];
  for (const raw of paths) {
    const trimmed = raw.trim().replace(/\/+$/, '');
    if (!trimmed || isAbsolute(trimmed)) {
      return { ok: false, error: `path "${raw}" must be relative to the repository root` };
    }
    const rel = posix(relative(root, join(root, trimmed)));
    if (rel === '..' || rel.startsWith('../')) return { ok: false, error: `path "${raw}" is outside the repository` };
    const normalised = rel === '' ? '.' : rel;
    try {
      accessSync(join(root, normalised), fsConstants.R_OK);
    } catch {
      return { ok: false, error: `path "${raw}" does not exist in the repository` };
    }
    if (!out.includes(normalised)) out.push(normalised);
  }
  return { ok: true, paths: out, scoped: !out.includes('.') };
}

export interface CandidateSearch {
  /** Absolute paths. */
  readonly files: readonly string[];
  /** Set when ripgrep could not answer at all. */
  readonly error: string | null;
  /** Set when ripgrep answered but reported unreadable paths (exit 2 with matches). */
  readonly partial: string | null;
}

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * The ripgrep binary to run, or null. An operator under a systemd user unit
 * does not necessarily inherit the login shell's PATH, and ripgrep is commonly
 * installed per user (~/.local/bin, ~/.cargo/bin), so those are searched after
 * PATH. `PAPERCUSP_RG` overrides all of them.
 */
export function resolveRipgrep(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  executable: (path: string) => boolean = isExecutable,
): string | null {
  const override = env.PAPERCUSP_RG?.trim();
  if (override) return isAbsolute(override) && executable(override) ? override : null;
  const dirs = [
    ...(env.PATH ?? '').split(delimiter).filter((d) => isAbsolute(d)),
    join(home, '.local', 'bin'),
    join(home, '.cargo', 'bin'),
    '/home/linuxbrew/.linuxbrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ];
  for (const dir of dirs) {
    const candidate = join(dir, 'rg');
    if (executable(candidate)) return candidate;
  }
  return null;
}

/** Source files under `root` (or under its relative `paths`) that contain `name` as a whole word. */
export function findCandidateFiles(
  root: string,
  name: string,
  rgPath = 'rg',
  paths: readonly string[] = ['.'],
): CandidateSearch {
  const r = spawnSync(
    rgPath,
    ['-l', '-w', '-F', '-g', FIRST_PARTY_SOURCE_GLOB, '-g', '!**/node_modules/**', '--', name, ...paths],
    { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (r.error) return { files: [], error: `ripgrep could not run (${rgPath}): ${r.error.message}`, partial: null };
  if (r.status === 1) return { files: [], error: null, partial: null };
  const files = r.stdout.split('\n').filter(Boolean).map((p) => join(root, p.replace(/^\.\//, '')));
  if (r.status === 0) return { files, error: null, partial: null };
  const why = `ripgrep exited ${r.status ?? r.signal}: ${(r.stderr ?? '').trim().split('\n')[0] ?? ''}`.trim();
  // rg exits 2 when any path was unreadable, even after printing matches.
  return files.length > 0 ? { files, error: null, partial: why } : { files: [], error: why, partial: null };
}

/** The name token a call expression invokes, when it is `name`, `x.name`, `x?.name`, `x['name']`. */
function calleeNameNode(ts: Ts, expr: TsModule.Expression): TsModule.Node | null {
  let e: TsModule.Expression = expr;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  if (ts.isIdentifier(e)) return e;
  if (ts.isPropertyAccessExpression(e)) return e.name;
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) return e.argumentExpression;
  return null;
}

const nameText = (ts: Ts, n: TsModule.Node): string =>
  ts.isIdentifier(n) || ts.isPrivateIdentifier(n) ? n.text : ts.isStringLiteralLike(n) ? n.text : '';

interface SyntacticCall {
  readonly site: SymbolSite;
  readonly nameNode: TsModule.Node;
}

/** Every `name(…)` / `x.name(…)` / `new name(…)` in one source file. */
function syntacticCalls(ts: Ts, sf: TsModule.SourceFile, path: string, name: string): SyntacticCall[] {
  const out: SyntacticCall[] = [];
  const visit = (node: TsModule.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const nameNode = calleeNameNode(ts, node.expression);
      if (nameNode && nameText(ts, nameNode) === name) {
        const line1 = sf.getLineAndCharacterOfPosition(nameNode.getStart(sf)).line + 1;
        out.push({ site: { path, line1, kind: null }, nameNode });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const posix = (p: string): string => p.split('\\').join('/');
const keyOf = (s: Pick<SymbolSite, 'path' | 'line1'>): string => `${s.path}:${s.line1 ?? '?'}`;
const bySite = (a: SymbolSite, b: SymbolSite): number => a.path.localeCompare(b.path) || (a.line1 ?? 0) - (b.line1 ?? 0);

interface SourceRelationship {
  readonly site: SymbolSite;
  readonly kind: CodeIntelRelationshipKind;
  readonly target?: SymbolSite;
}

/** Compiler bindings, not same-spelled names, join context's source sites. */
function contextRelationships(tree: TsTree, program: TsModule.Program, selected: TsDeclaration): SourceRelationship[] {
  const { ts } = tree;
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(selected.file)!;
  let nameNode: TsModule.Node | undefined;
  // Navigate-to sites omit name; the exact token identifies the declaration.
  const findToken = (node: TsModule.Node): void => {
    if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)) && node.getStart(sf) === selected.namePos) nameNode = node;
    if (!nameNode && node.pos <= selected.namePos && node.end >= selected.namePos) ts.forEachChild(node, findToken);
  };
  findToken(sf);
  if (!nameNode) return [];
  const declaration = nameNode.parent;
  const out: SourceRelationship[] = [];
  const seen = new Set<string>();
  const siteOf = (node: TsModule.Node, name?: string): SymbolSite => ({
    ...tsSiteOf(tree, program, node.getSourceFile().fileName, node.getStart(), ts.SyntaxKind[node.parent.kind].toLowerCase()),
    ...(name ? { name } : {}),
  });
  const unalias = (sym: TsModule.Symbol | undefined): TsModule.Symbol | undefined =>
    sym && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
  const targetOf = (sym: TsModule.Symbol | undefined): SymbolSite | undefined => {
    const d = unalias(sym)?.declarations?.[0];
    if (!d) return undefined;
    const file = d.getSourceFile();
    if (isExternalPath(posix(relative(tree.root, file.fileName))) || program.isSourceFileDefaultLibrary(file)) return undefined;
    const named = d as TsModule.NamedDeclaration;
    return siteOf(named.name ?? d, sym?.name);
  };
  const add = (kind: CodeIntelRelationshipKind, node: TsModule.Node, target?: SymbolSite, name?: string): void => {
    const site = siteOf(node, name);
    const key = JSON.stringify([kind, site.path, site.line1, name, target?.path, target?.line1]);
    if (!seen.has(key)) { seen.add(key); out.push({ kind, site, ...(target ? { target } : {}) }); }
  };
  // Imports actually referenced by this declaration; module bindings are resolved by TS.
  const imports = (node: TsModule.Node): void => {
    if (ts.isIdentifier(node)) {
      const sym = checker.getSymbolAtLocation(node);
      for (const d of sym?.flags && sym.flags & ts.SymbolFlags.Alias ? sym.declarations ?? [] : []) {
        if (ts.isImportSpecifier(d) || ts.isImportClause(d) || ts.isNamespaceImport(d) || ts.isImportEqualsDeclaration(d)) {
          const target = targetOf(sym);
          if (target) add('imports', d.name!, target, d.name!.getText());
        }
      }
    }
    ts.forEachChild(node, imports);
  };
  imports(declaration);
  const containers = ts.isClassLike(declaration) || ts.isInterfaceDeclaration(declaration) ? [declaration]
    : ts.isClassLike(declaration.parent) || ts.isInterfaceDeclaration(declaration.parent) ? [declaration.parent] : [];
  for (const container of containers) {
    if (container === declaration) {
      for (const clause of container.heritageClauses ?? []) for (const type of clause.types) {
        const target = targetOf(checker.getSymbolAtLocation(type.expression));
        if (target) add(clause.token === ts.SyntaxKind.ImplementsKeyword ? 'implementations' : 'inheritance',
          type.expression, target, type.expression.getText());
      }
      for (const member of container.members) {
        const named = member as TsModule.NamedDeclaration;
        if (named.name) add('members', named.name, siteOf(named.name), named.name.getText());
      }
    }
    const type = checker.getTypeAtLocation(container) as TsModule.InterfaceType;
    const bases = type.flags & ts.TypeFlags.Object ? checker.getBaseTypes(type) ?? [] : [];
    for (const member of container === declaration ? container.members : [declaration]) {
      const named = member as TsModule.NamedDeclaration;
      if (!named.name) continue;
      const name = nameText(ts, named.name);
      for (const base of bases) {
        const target = targetOf(base.getProperty(name));
        if (target) add('overrides', named.name, target, name);
      }
    }
  }
  const fields = (ts.isClassLike(declaration) || ts.isInterfaceDeclaration(declaration) ? declaration.members : [declaration])
    .filter((member): member is TsModule.PropertyDeclaration | TsModule.PropertySignature =>
      ts.isPropertyDeclaration(member) || ts.isPropertySignature(member));
  // Instantiated `this` properties can be transient symbols with the same source declaration.
  const fieldDeclarations = new Set<TsModule.Declaration>(fields);
  for (const file of program.getSourceFiles()) {
    if (isExternalPath(posix(relative(tree.root, file.fileName))) || program.isSourceFileDefaultLibrary(file)) continue;
    const accesses = (node: TsModule.Node): void => {
      const token = ts.isPropertyAccessExpression(node) ? node.name
        : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression : undefined;
      if (token) {
        const sym = ts.isPropertyAccessExpression(node) ? checker.getSymbolAtLocation(token)
          : checker.getTypeAtLocation((node as TsModule.ElementAccessExpression).expression).getProperty(nameText(ts, token));
        if (sym?.declarations?.some(d => fieldDeclarations.has(d))) {
          const target = targetOf(sym)!;
          let expression: TsModule.Node = node;
          while (ts.isParenthesizedExpression(expression.parent) || ts.isNonNullExpression(expression.parent)) expression = expression.parent;
          const parent = expression.parent;
          const assignment = ts.isBinaryExpression(parent) && parent.left === expression &&
            parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
          const increment = (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
            (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken);
          const deletion = ts.isDeleteExpression(parent);
          const write = assignment || increment || deletion;
          const read = (!assignment || parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken) && !deletion;
          if (read) add('field-read', token, target, nameText(ts, token));
          if (write) add('field-write', token, target, nameText(ts, token));
        }
      }
      ts.forEachChild(node, accesses);
    };
    accesses(file);
  }
  return out.sort((a, b) => bySite(a.site, b.site) || a.kind.localeCompare(b.kind));
}

/** Why the checker did not put this call in the hierarchy, as a reason and a human detail. */
function classify(
  ts: Ts,
  checker: TsModule.TypeChecker,
  root: string,
  program: TsModule.Program,
  call: SyntacticCall,
): { reason: UnattributedReason; detail: string } {
  let sym = checker.getSymbolAtLocation(call.nameNode);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  const decl = sym?.declarations?.[0];
  if (!decl) {
    return {
      reason: 'unresolved',
      detail: 'unattributed: the checker cannot type the receiver (any, untyped JS, or a type only inferable outside this query)',
    };
  }
  const sf = decl.getSourceFile();
  const rel = posix(relative(root, sf.fileName));
  if (isExternalPath(rel) || program.isSourceFileDefaultLibrary(sf)) {
    return { reason: 'external', detail: `unattributed: resolves to a declaration outside the repo (${rel.split('/').slice(-2).join('/')})` };
  }
  const line1 = sf.getLineAndCharacterOfPosition(decl.getStart(sf)).line + 1;
  return { reason: 'other-in-repo', detail: `unattributed: resolves to ${rel}:${line1}, which the call hierarchy did not report` };
}

function compilerInterfaceEvidence(ts: Ts, program: TsModule.Program, root: string, limit: number): CompilerInterfaceEvidence {
  const checker = program.getTypeChecker();
  const diagnostics: { site: SymbolSite; code: number; message: string }[] = [];
  const registrations: Array<CompilerInterfaceEvidence['registrations'][number]> = [];
  const interactions: Array<NonNullable<CompilerInterfaceEvidence['interactions']>[number]> = [];
  const sources = new Map<string, CodeIntelSourceFile>();
  let truncated = false;
  const site = (node: TsModule.Node, kind: string): SymbolSite | null => {
    const sf = node.getSourceFile(), path = posix(relative(root, sf.fileName));
    if (isExternalPath(path) || program.isSourceFileDefaultLibrary(sf)) return null;
    sources.set(path, { path, contentHash: createHash('sha256').update(sf.text).digest('hex'),
      language: /\.[cm]?jsx?$/.test(path) ? 'javascript' : 'typescript', representation: 'full-source' });
    return { path, line1: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, kind, detail: null };
  };
  const reference = (node: TsModule.Node | undefined, kind: string) => {
    if (!node) return null;
    let symbol = ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return site(symbol?.declarations?.[0] ?? node, kind);
  };
  const fields = (type: TsModule.Type | undefined, at: TsModule.Node | undefined) => {
    if (!type || !at || type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return null;
    const properties = type.getProperties();
    if (properties.length > 50) { truncated = true; return null; }
    return properties.map(property => ({ name: property.getName(),
      type: checker.typeToString(checker.getTypeOfSymbolAtLocation(property, at)),
      optional: Boolean(property.flags & ts.SymbolFlags.Optional) }));
  };
  const factoryEvidence = (expression: TsModule.Expression) => {
    // Inspect the bound import before unaliasing. Same-spelled local factories
    // are candidates only; they are never evidence of platform registration.
    const bound = checker.getSymbolAtLocation(expression);
    const imported = bound?.declarations?.find(ts.isImportSpecifier);
    let declaration: TsModule.ImportDeclaration | undefined;
    if (imported && (imported.propertyName ?? imported.name).text === 'defineTool' && ts.isImportDeclaration(imported.parent.parent.parent))
      declaration = imported.parent.parent.parent;
    if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'defineTool') {
      const namespace = checker.getSymbolAtLocation(expression.expression)?.declarations?.find(ts.isNamespaceImport);
      if (namespace && ts.isImportDeclaration(namespace.parent.parent)) declaration = namespace.parent.parent;
    }
    const moduleName = declaration && ts.isStringLiteralLike(declaration.moduleSpecifier) ? declaration.moduleSpecifier.text : null;
    let resolved = bound;
    if (resolved && resolved.flags & ts.SymbolFlags.Alias) resolved = checker.getAliasedSymbol(resolved);
    const definition = resolved?.declarations?.[0];
    const definitionPath = definition ? posix(relative(root, definition.getSourceFile().fileName)) : null;
    const maintainedSource = resolved?.getName() === 'defineTool' && definitionPath === 'libs/generic/tooldef/src/define-tool.ts';
    const maintainedImport = moduleName === '@papercusp/agent-mcp' || moduleName === '@papercusp/tooldef';
    if (!maintainedImport && !maintainedSource && resolved?.getName() !== 'defineTool'
      && !(ts.isIdentifier(expression) && expression.text === 'defineTool')
      && !(ts.isPropertyAccessExpression(expression) && expression.name.text === 'defineTool')) return null;
    return { factoryAuthority: maintainedSource ? 'maintained-source' as const
      : maintainedImport ? 'maintained-import' as const : 'unverified' as const,
      factory: site(maintainedSource ? definition! : declaration ?? definition ?? expression, 'registration-factory') };
  };
  for (const sf of program.getSourceFiles()) {
    const path = posix(relative(root, sf.fileName));
    if (isExternalPath(path) || program.isSourceFileDefaultLibrary(sf)) continue;
    for (const diagnostic of program.getSemanticDiagnostics(sf)) {
      if (diagnostic.category !== ts.DiagnosticCategory.Error || diagnostic.start === undefined) continue;
      if (diagnostics.length >= limit) { truncated = true; continue; }
      sources.set(path, { path, contentHash: createHash('sha256').update(sf.text).digest('hex'),
        language: /\.[cm]?jsx?$/.test(path) ? 'javascript' : 'typescript', representation: 'full-source' });
      diagnostics.push({ site: { path, line1: sf.getLineAndCharacterOfPosition(diagnostic.start).line + 1,
        kind: 'compiler-diagnostic', detail: null }, code: diagnostic.code,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n').slice(0, 600) });
    }
    const visit = (node: TsModule.Node): void => {
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const member = ts.isPropertyAccessExpression(expression) ? expression.name.text : null;
        const called = ts.isIdentifier(expression) ? expression.text : member;
        const staticText = (value: TsModule.Node | undefined) => value && ts.isStringLiteralLike(value) ? value.text : null;
        const add = (protocol: 'http' | 'rpc' | 'event', role: 'producer' | 'consumer', key: string | null,
          method: string | null, authority: 'compiler-global' | 'maintained-import' | 'syntax', handler: TsModule.Node | undefined) => {
          if (interactions.length >= limit) { truncated = true; return; }
          interactions.push({ protocol, role, key, method, site: site(node, `${protocol}-${role}`)!,
            handler: reference(handler, `${protocol}-handler`), authority, middleware: 'unknown', runtimeExecution: 'unknown' });
        };
        if (called === 'fetch') {
          const symbol = checker.getSymbolAtLocation(expression);
          const authority = symbol?.declarations?.some(declaration => program.isSourceFileDefaultLibrary(declaration.getSourceFile()))
            ? 'compiler-global' : 'syntax';
          const options = node.arguments[1];
          const props = options && ts.isObjectLiteralExpression(options) ? options.properties : [];
          const method = props.find(prop => ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'method');
          const dynamic = Boolean(options && (!ts.isObjectLiteralExpression(options) || props.some(prop => ts.isSpreadAssignment(prop)
            || !('name' in prop) || !prop.name || ts.isComputedPropertyName(prop.name))));
          add('http', 'consumer', staticText(node.arguments[0]), dynamic ? null
            : method && ts.isPropertyAssignment(method) ? staticText(method.initializer)?.toUpperCase() ?? null : 'GET', authority, undefined);
        } else if (called === 'dispatchTool') {
          add('rpc', 'consumer', staticText(node.arguments[0]), null, 'syntax', undefined);
        } else if (member === 'emit' || member === 'on' || member === 'once' || member === 'addListener') {
          add('event', member === 'emit' ? 'producer' : 'consumer', staticText(node.arguments[0]), null, 'syntax', member === 'emit' ? undefined : node.arguments[1]);
        }
        const factory = factoryEvidence(node.expression);
        if (factory && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
          if (registrations.length >= limit) { truncated = true; return; }
          const props = new Map<string, TsModule.Node>();
          let dynamic = false;
          for (const prop of node.arguments[0].properties) {
            if (!(ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop) || ts.isMethodDeclaration(prop))
              || (!ts.isIdentifier(prop.name) && !ts.isStringLiteralLike(prop.name))) { dynamic = true; continue; }
            props.set(prop.name.text, ts.isPropertyAssignment(prop) ? prop.initializer : ts.isShorthandPropertyAssignment(prop) ? prop.name : prop);
          }
          // A spread/computed key may replace a literal handler or validator.
          // Do not turn an unevaluated object into an authoritative contract.
          if (dynamic) props.clear();
          const literal = (key: string) => { const value = props.get(key); return value && ts.isStringLiteralLike(value) ? value.text : null; };
          const kind = dynamic ? 'unknown' : props.has('method') && props.has('path') ? 'route' : 'tool';
          const handler = props.get('handler');
          const signature = handler ? checker.getTypeAtLocation(handler).getCallSignatures()[0] : undefined;
          const parameter = signature?.parameters[0];
          const result = signature ? checker.getAwaitedType(checker.getReturnTypeOfSignature(signature)) : undefined;
          registrations.push({ name: literal('name'), kind, method: kind === 'route' ? literal('method') : null,
            path: kind === 'route' ? literal('path') : null, ...factory,
            site: site(node, `static-${kind}-registration`)!, implementation: reference(props.get('handler'), `${kind}-implementation`),
            requestValidator: reference(kind === 'route' ? props.get('input') : props.get('args') ?? props.get('input'), 'request-validator'),
            // Tool result/output are executable validators. returns is prose.
            responseValidator: kind === 'tool' ? reference(props.get('result') ?? props.get('output'), 'response-validator') : null,
            requestFields: fields(parameter && handler ? checker.getTypeOfSymbolAtLocation(parameter, handler) : undefined, handler),
            responseFields: fields(result, handler),
            documentation: reference(props.get('publicDoc') ?? props.get('description') ?? props.get('guidance'), 'contract-documentation'), runtimeRegistered: 'unmeasured' });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { status: 'measured', diagnostics, registrations, interactions, sources: [...sources.values()].sort((a, b) => a.path.localeCompare(b.path)), truncated,
    limitations: ['Diagnostics describe the captured TypeScript program, not executed runtime failures.',
      'Static defineTool object candidates are linked; factoryAuthority distinguishes maintained imports/source from unverified same-name factories. Imports do not prove loaded runtime registration.',
      'Dynamic names, methods, paths and spreads remain unmeasured; route response validators are not declared by the route primitive. Runtime validation is not executed.',
      'Untyped or any-valued clients can escape compiler diagnostics; this is not registry or client completeness proof.',
      'Transport calls and event emitter candidates are static syntax; receiver identity, middleware, service routing and runtime execution are unmeasured.'] };
}

function buildAnswer(
  name: string,
  started: number,
  now: () => number,
  parts: { sites?: SymbolSite[]; total?: number; error?: string | null; attribution?: FirstPartyCallersAttribution | null; limitations?: string[]; evidence?: CodeIntelSourceEvidence; intent?: CodeIntelAnswer['intent'] },
): FirstPartyCallersAnswer {
  const sites = parts.sites ?? [];
  const total = parts.total ?? sites.length;
  const error = parts.error ?? null;
  return {
    backend: 'typescript-service',
    intent: parts.intent ?? 'callers',
    query: name,
    sites,
    truncation: { truncated: total > sites.length, totalAvailable: total, continuation: null },
    freshness: {
      health: error ? 'unhealthy' : 'healthy',
      // Built from disk for this query: there is no index to go stale.
      indexedAt: new Date(started).toISOString(),
      staleVsDisk: error ? null : false,
      indexedCommit: null,
    },
    coverage: {
      basis: 'compiler-project',
      sourceCompleteness: 'unverified',
      limitations: [
        'Searched files are the source files ripgrep finds containing the name as a whole word; gitignored, hidden and node_modules paths are not searched.',
        parts.intent && parts.intent !== 'callers' ? 'Native symbol/context/callees require one selected declaration; ambiguous or unsupported declarations carry an error.'
          : 'Unattributed sites are syntactic calls the checker did not link to a declaration of this name; each says why.',
        'A site is a line: two calls on one line are one site.',
        ...(parts.limitations ?? []),
      ],
    },
    latencyMs: Math.round(now() - started),
    error,
    attribution: parts.attribution ?? null,
    ...(parts.evidence ? { evidence: parts.evidence } : {}),
  };
}

/**
 * The answer for a question this backend could not run at all (the off-thread
 * worker failed, timed out, or could not load TypeScript). Never a bare empty:
 * `error` is set and health is unhealthy.
 */
export function failedCallersAnswer(name: string, error: string, startedMs: number, nowMs: number = Date.now(),
  scope?: Pick<FirstPartyCallersQuery, 'root' | 'repositoryId' | 'paths' | 'op'>): FirstPartyCallersAnswer {
  const result = buildAnswer(name, startedMs, () => nowMs, { error,
    intent: scope?.op === 'impact' || scope?.op === 'trace' ? scope.op
      : scope?.op === 'callees' ? 'callees' : scope?.op && scope.op !== 'callers' ? 'definition' : 'callers' });
  return { ...result, evidence: unmeasuredCallersEvidence(result, scope) };
}

function unmeasuredCallersEvidence(result: Pick<CodeIntelAnswer, 'intent' | 'sites'>,
  scope?: Pick<FirstPartyCallersQuery, 'root' | 'repositoryId' | 'paths'>): CodeIntelSourceEvidence {
  let repositoryId = scope?.repositoryId ?? null;
  let identityKind: CodeIntelSourceEvidence['sourceScope']['identityKind'] = repositoryId ? 'registry' : 'unknown';
  if (!repositoryId && scope?.root) {
    try {
      repositoryId = `local-root:${createHash('sha256').update(realpathSync(scope.root)).digest('hex')}`;
      identityKind = 'local-root';
    } catch { /* An inaccessible root has no verified local identity. */ }
  }
  return unmeasuredSourceEvidence(result, { repositoryId, identityKind,
    paths: scope?.paths ?? ['.'], basis: 'compiler-project' }, [
    'No compiler snapshot was measured; an empty or failed query does not establish source completeness.',
  ]);
}

/** Who calls `name`, from the first-party TypeScript backend. Synchronous: run it off the main thread. */
export function firstPartyCallers(q: FirstPartyCallersQuery): FirstPartyCallersAnswer {
  const now = q.now ?? (() => Date.now());
  const started = now();
  const op = q.op ?? 'callers';
  const discovery = ['communities', 'flows', 'concept-search'].includes(op);
  const intent = discovery ? op === 'concept-search' ? 'text-search' : 'structural-search'
    : op === 'impact' || op === 'trace' ? op : op === 'callees' ? 'callees' : op === 'callers' ? 'callers' : 'definition';
  const answer = (name: string, startedAt: number, clock: () => number, parts: Parameters<typeof buildAnswer>[3]) => {
    const result = buildAnswer(name, startedAt, clock, { ...parts, intent });
    return parts.evidence ? result : { ...result, evidence: unmeasuredCallersEvidence(result, q) };
  };
  const limit = Math.max(1, Math.floor(q.limit ?? FIRST_PARTY_CALLERS_DEFAULT_LIMIT));
  if (!['callers', 'symbol', 'callees', 'context', 'impact', 'trace', 'contracts', 'communities', 'flows', 'concept-search'].includes(op)) {
    return answer(q.name, started, now, { error: `unsupported first-party graph operation '${op}'` });
  }
  const unsupportedLanguages: Record<string, string> = { '.rs': 'rust', '.py': 'python', '.go': 'go',
    '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp' };
  const unsupportedAnswer = (extensions: string[]): FirstPartyCallersAnswer => {
    const unsupported = answer(q.name, started, now, { error: `Native graph ${op} is unsupported for '${extensions.join(', ')}'; this compiler route admits JS/TS only. Use the registered language's lsp:query or code:structural route.` });
    return { ...unsupported, evidence: { ...unsupported.evidence!, languageCapabilities:
      [...new Set(extensions.map(extension => unsupportedLanguages[extension] ?? 'unknown'))]
        .map(language => ({ language, intent, status: 'unsupported' as const })) } };
  };
  if (q.filePath && !/\.[cm]?[jt]sx?$/.test(q.filePath)) {
    return unsupportedAnswer([extname(q.filePath)]);
  }
  const unsupportedPaths = (q.paths ?? []).map(path => extname(path)).filter(extension => unsupportedLanguages[extension]);
  if (unsupportedPaths.length) {
    return unsupportedAnswer([...new Set(unsupportedPaths)]);
  }
  if (discovery && (!q.paths?.length || q.paths.some(path => path === '.' || path === './'))) {
    return answer(q.name, started, now, { error: 'Discovery requires explicit bounded source paths, not the whole repository.' });
  }
  if (op === 'concept-search' && (!q.name.trim() || q.name.length > 500)) {
    return answer(q.name, started, now, { error: 'concept-search requires a non-empty query of at most 500 characters in name.' });
  }
  if (!discovery && !IDENTIFIER.test(q.name)) {
    return answer(q.name, started, now, { error: `callers needs one identifier; "${q.name}" is not one` });
  }
  const rgPath = q.rgPath ?? resolveRipgrep();
  if (rgPath === null) {
    return answer(q.name, started, now, {
      error: 'ripgrep (rg) was not found on PATH, in ~/.local/bin, ~/.cargo/bin or the system bin dirs; set PAPERCUSP_RG',
    });
  }
  const scope = resolveSearchPaths(q.root, q.paths);
  if (!scope.ok) return answer(q.name, started, now, { error: scope.error });
  const citedContext = q.contextScope === 'cited-files';
  if (citedContext && (op !== 'context' || q.includeInterfaces || !q.paths?.length
    || q.paths.some(path => !/\.[cm]?[jt]sx?$/.test(path)))) {
    return answer(q.name, started, now, { error: 'Cited-file context requires op:context, explicit source files and no interface enrichment.' });
  }
  if (op === 'trace' && (!q.target || !IDENTIFIER.test(q.target))) {
    return answer(q.name, started, now, { error: 'trace requires target: one exact symbol identifier' });
  }
  if (q.targetFilePath) {
    const targetScope = resolveSearchPaths(q.root, [q.targetFilePath]);
    if (!targetScope.ok) return answer(q.name, started, now, { error: targetScope.error });
    const physical = posix(relative(realpathSync(q.root), realpathSync(join(q.root, targetScope.paths[0]!))));
    if (isExternalPath(physical)) return answer(q.name, started, now, { error: 'target file resolves outside the repository' });
  }
  let definingPath: string | undefined;
  if (op !== 'callers' && q.filePath) {
    const selected = resolveSearchPaths(q.root, [q.filePath]);
    if (!selected.ok) return answer(q.name, started, now, { error: selected.error });
    definingPath = selected.paths[0];
    const physical = posix(relative(realpathSync(q.root), realpathSync(join(q.root, definingPath!))));
    if (isExternalPath(physical)) return answer(q.name, started, now, { error: 'defining file resolves outside the repository' });
  }
  // Transitive callers may never spell the initial name. Traverse a full scoped
  // source program, instead of treating the single-name candidate set as a graph.
  const search = discovery || citedContext || op === 'impact' || op === 'trace' || q.includeInterfaces ? traversalSourceFiles(q.root, rgPath, scope.paths)
    : findCandidateFiles(q.root, q.name, rgPath, scope.paths);
  if (search.error) return answer(q.name, started, now, { error: search.error });
  const partial = [
    ...(scope.scoped ? [`Searched only under: ${scope.paths.join(', ')}.`] : []),
    ...(search.partial ? [`ripgrep could not read every path: ${search.partial}`] : []),
  ];
  if (search.files.length === 0) {
    // A JS/TS-only candidate filter cannot establish absence in a directory
    // containing another language. Inspect names, never infer support from an
    // empty filtered search. Missing/unreadable census is also a refusal.
    if (scope.scoped) {
      const census = spawnSync(rgPath, ['--files', '-g', '!**/node_modules/**', '--', ...scope.paths],
        { cwd: q.root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      if (census.error || (census.status !== 0 && census.status !== 1)) {
        return answer(q.name, started, now, { error: 'Source-language census failed; compiler absence is unverified.' });
      }
      const extensions = [...new Set(census.stdout.split('\n').map(path => extname(path))
        .filter(extension => unsupportedLanguages[extension]))];
      if (extensions.length) return unsupportedAnswer(extensions);
    }
    // No searched source file contains the word: as strong an absence as grep's.
    return answer(q.name, started, now, {
      ...(op !== 'callers' ? { error: discovery ? 'No admitted JS/TS source files in the discovery scope.' : `No declaration named '${q.name}' in the searched source scope` } : {}),
      limitations: partial,
      attribution: {
        resolved: 0,
        unattributed: { external: 0, 'other-in-repo': 0, unresolved: 0 },
        declarations: [],
        declarationCount: 0,
        candidateFiles: 0,
        stubbedFiles: 0,
      },
    });
  }

  // A symbol query returns declarations in the selected candidate files. Like
  // callers, it only needs re-export links outside those files; loading every
  // dependency body turns a single declaration lookup into a whole-project
  // checker (EI-25679714152389108). Outgoing/context queries still need the
  // actual reached declarations and retain their full compiler snapshots.
  // Reverse impact searches incoming calls in the requested full-source files.
  // Bodies outside that scope add no certified callers; retain their re-export
  // links without turning a bounded planning advisory into a whole-project load.
  const incomingScope = scope.scoped && op === 'impact' && (q.direction ?? 'downstream') === 'downstream';
  const declarationScope = (discovery || citedContext || op === 'callers' || op === 'symbol' || incomingScope) && !q.includeInterfaces;
  const tree = openScopedTsTree(q.ts, q.root, search.files,
    declarationScope ? undefined : (_ts, _file, text) => text, q.authorizedReadRoots);
  try {
    const program = tree.service.getProgram();
    if (!program) return answer(q.name, started, now, { error: 'TypeScript produced no program for the candidate files' });
    if (discovery) return { ...compilerDiscovery(q, tree, program, scope.paths, partial, started, now), attribution: null };
    if (op === 'contracts') {
      const interfaces = compilerInterfaceEvidence(q.ts, program, q.root, limit);
      const sources: CodeIntelSourceFile[] = program.getSourceFiles().flatMap(sf => {
        const path = posix(relative(q.root, sf.fileName));
        if (isExternalPath(path) || program.isSourceFileDefaultLibrary(sf)) return [];
        return [{ path, contentHash: createHash('sha256').update(sf.text).digest('hex'),
          language: /\.[cm]?jsx?$/.test(path) ? 'javascript' : 'typescript', representation: 'full-source' as const }];
      }).sort((a, b) => a.path.localeCompare(b.path));
      for (const [file, text] of tree.configReads) {
        const path = posix(relative(q.root, file));
        if (!isExternalPath(path)) sources.push({ path, contentHash: createHash('sha256').update(text).digest('hex'),
          language: 'json', representation: 'full-source' });
      }
      sources.sort((a, b) => a.path.localeCompare(b.path));
      const sites = [...interfaces.registrations.map(row => row.site), ...(interfaces.interactions ?? []).map(row => row.site)];
      const result = answer(q.name, started, now, { sites, intent: 'diagnostics', limitations: [...interfaces.limitations] });
      const repositoryId = q.repositoryId ?? `local-root:${createHash('sha256').update(realpathSync(q.root)).digest('hex')}`;
      const evidence = unmeasuredCallersEvidence(result, q);
      const sourceByPath = new Map(sources.map(source => [source.path, source]));
      return { ...result, interfaces, evidence: { ...evidence,
        sourceScope: { ...evidence.sourceScope, repositoryId, identityKind: q.repositoryId ? 'registry' : 'local-root',
          sourceFingerprint: createHash('sha256').update(JSON.stringify(sources)).digest('hex'), supportingFiles: sources },
        siteIdentities: sites.map((site, siteIndex) => ({ siteIndex, sourcePath: site.path,
          contentHash: sourceByPath.get(site.path)?.contentHash ?? null,
          versionedSymbolId: versionedSymbolIdentity(repositoryId, site, sourceByPath.get(site.path)) })), relationships: [] },
        truncation: { truncated: interfaces.truncated, totalAvailable: sites.length, continuation: null } };
    }
    const withInterfaces = (result: FirstPartyCallersAnswer): FirstPartyCallersAnswer => {
      if (!q.includeInterfaces) return result;
      const interfaces = compilerInterfaceEvidence(q.ts, program, q.root, limit);
      if (!result.evidence || result.error) return { ...result, interfaces: { ...interfaces, status: 'unknown' } };
      const supporting = new Map(result.evidence.sourceScope.supportingFiles.map(file => [file.path, file]));
      for (const source of interfaces.sources) supporting.set(source.path, source);
      return { ...result, interfaces, evidence: { ...result.evidence, sourceScope: { ...result.evidence.sourceScope,
        supportingFiles: [...supporting.values()].sort((a, b) => a.path.localeCompare(b.path)) } } };
    };
    const decls = tsDeclarations(tree, program, q.name).filter(d => op === 'callers' ||
      (tree.rootFiles.has(d.file) && (!definingPath || d.site.path === definingPath) &&
       (q.line1 === undefined || d.site.line1 === q.line1) &&
       (!q.kind || d.site.kind?.toLowerCase() === q.kind.toLowerCase())));
    if (op === 'impact' || op === 'trace') {
      const result = compilerTraversal(q, tree, program, decls, scope.paths, partial, started, now, declarationScope);
      return withInterfaces({ ...result, attribution: { resolved: result.sites.length,
        unattributed: { external: 0, 'other-in-repo': 0, unresolved: 0 },
        declarations: decls.slice(0, 50).map(d => d.site), declarationCount: decls.length,
        candidateFiles: search.files.length, stubbedFiles: tree.stubbedFiles() } });
    }
    const nativeOutgoing: SymbolSite[] = [];
    const nativeRelations = new Map<SymbolSite, SourceRelationship>();
    let unsupportedTargets = 0;
    let nativeError: string | null = null;
    if (op !== 'callers') {
      if (decls.length !== 1) nativeError = decls.length === 0
        ? `No declaration named '${q.name}' matches the defining-file/line/kind selector`
        : `Ambiguous symbol '${q.name}': ${decls.map(d => `${d.site.path}:${d.site.line1}`).join(', ')}. Supply file_path and, when needed, line1.`;
      else if (op !== 'symbol') {
        const items = hierarchyItems(tree, decls[0]!);
        if (items.length === 0 && op === 'callees') nativeError = 'Outgoing call hierarchy is unsupported for this declaration';
        for (const item of items) {
          for (const call of tree.service.provideCallHierarchyOutgoingCalls(item.file, item.selectionSpan.start)) {
            const target = { ...tsSiteOf(tree, program, call.to.file, call.to.selectionSpan.start, call.to.kind), name: call.to.name };
            if (isExternalPath(target.path)) { unsupportedTargets += 1; continue; }
            for (const span of call.fromSpans) {
              const site = { ...tsSiteOf(tree, program, item.file, span.start, call.to.kind), name: call.to.name,
                detail: `calls ${call.to.name}; target ${target.path}:${target.line1}` };
              nativeOutgoing.push(site);
              nativeRelations.set(site, { site, kind: 'callees', target });
            }
          }
        }
      }
    }
    const context = op === 'context' && !nativeError ? contextRelationships(tree, program, decls[0]!) : [];
    for (const relation of context) nativeRelations.set(relation.site, relation);
    const resolved = op === 'callers' ? incomingCallSites(tree, program, decls) : nativeOutgoing;
    const resolvedKeys = new Set(resolved.map(keyOf));
    const declKeys = new Set(decls.map((d) => keyOf(d.site)));

    const counts: Record<UnattributedReason, number> = { external: 0, 'other-in-repo': 0, unresolved: 0 };
    const unattributed: SymbolSite[] = [];
    const seen = new Set<string>();
    for (const file of op === 'callers' ? search.files : []) {
      const checker = program.getTypeChecker();
      const sf = program.getSourceFile(file);
      if (!sf) continue;
      for (const call of syntacticCalls(q.ts, sf, posix(relative(q.root, file)), q.name)) {
        const key = keyOf(call.site);
        if (resolvedKeys.has(key) || declKeys.has(key) || seen.has(key)) continue;
        seen.add(key);
        const { reason, detail } = classify(q.ts, checker, q.root, program, call);
        counts[reason] += 1;
        unattributed.push({ ...call.site, detail });
      }
    }

    const all = op === 'callers' ? [...resolved.sort(bySite), ...unattributed.sort(bySite)]
      : nativeError || op === 'symbol' ? decls.map(d => d.site)
      : op === 'context' ? [...decls.map(d => d.site), ...nativeOutgoing.sort(bySite), ...context.map(r => r.site)] : nativeOutgoing.sort(bySite);
    const reported = all.slice(0, limit);
    // Hash the exact compiler snapshots, including re-export stubs. Reading disk
    // after the worker answers could attach a different version to the old sites.
    const sources: CodeIntelSourceFile[] = program.getSourceFiles().flatMap(sf => {
      const path = posix(relative(q.root, sf.fileName));
      if (isExternalPath(path) || program.isSourceFileDefaultLibrary(sf)) return [];
      return [{ path, contentHash: createHash('sha256').update(sf.text).digest('hex'),
        language: /\.[cm]?jsx?$/.test(path) ? 'javascript' : 'typescript',
        representation: !declarationScope || tree.rootFiles.has(sf.fileName) ? 'full-source' as const : 'reexport-stub' as const }];
    }).sort((a, b) => a.path.localeCompare(b.path));
    const repositoryId = q.repositoryId ?? `local-root:${createHash('sha256').update(realpathSync(q.root)).digest('hex')}`;
    const sourceByPath = new Map(sources.map(source => [source.path, source]));
    const supporting = new Set(reported.map(site => site.path));
    for (const site of reported) {
      const target = nativeRelations.get(site)?.target;
      if (target) supporting.add(target.path);
    }
    const evidence: CodeIntelSourceEvidence = {
      schemaVersion: 1,
      sourceScope: { repositoryId, identityKind: q.repositoryId ? 'registry' : 'local-root',
        sourceFingerprint: createHash('sha256').update(JSON.stringify(sources)).digest('hex'),
        paths: scope.paths, supportingFiles: sources.filter(source => supporting.has(source.path)) },
      graphScope: { basis: 'compiler-project', sourceCompleteness: 'unverified', limitations: [
        ...(citedContext ? ['Context is restricted to the explicitly cited source files; dependency bodies and relationships outside those files are not inspected.'] : []),
        ...partial, declarationScope ? 'Only candidate files are full compiler inputs; other reached files are re-export stubs.'
          : 'Candidate files and reached in-repository dependencies are full compiler snapshots; this is not a repository-wide completeness proof.',
        'Compiler or syntactic relationships do not establish runtime execution; unresolved target bindings remain unknown.' ] },
      languageCapabilities: [...new Set(sources.map(source => source.language))].map(language =>
        ({ language, intent, status: 'compiler-backed' })),
      siteIdentities: reported.map((site, siteIndex) => ({ siteIndex, sourcePath: site.path,
        contentHash: sourceByPath.get(site.path)?.contentHash ?? null,
        versionedSymbolId: versionedSymbolIdentity(repositoryId, site, sourceByPath.get(site.path)) })),
      relationships: reported.map((site, siteIndex) => ({ siteIndex,
        kind: op === 'callers' ? 'callers' : nativeRelations.get(site)?.kind ?? 'definition',
        origin: op !== 'callers' || resolvedKeys.has(keyOf(site)) ? 'compiler' : 'syntax',
        knowledge: op !== 'callers' || resolvedKeys.has(keyOf(site)) ? 'observed' : 'unknown', runtimeExecution: 'unknown',
        ...(nativeRelations.get(site)?.target ? { target: {
          site: nativeRelations.get(site)!.target!,
          contentHash: sourceByPath.get(nativeRelations.get(site)!.target!.path)!.contentHash,
          versionedSymbolId: versionedSymbolIdentity(repositoryId, nativeRelations.get(site)!.target!, sourceByPath.get(nativeRelations.get(site)!.target!.path)),
        } } : {}),
      })),
    };
    return withInterfaces(answer(q.name, started, now, {
      sites: reported,
      evidence,
      error: nativeError,
      total: all.length,
      limitations: [...partial,
        ...(op === 'context' ? ['Context joins resolved in-repository imports, declared heritage, members, overrides and typed property accesses within the bounded compiler program. Structural implementations use lsp:query op:implementations; dynamic/computed fields and unresolved/external context targets are unsupported.'] : []),
        ...(unsupportedTargets ? [`Omitted ${unsupportedTargets} external call targets whose source repository/version this query cannot certify.`] : []),
      ],
      attribution: {
        resolved: resolved.length,
        unattributed: counts,
        declarations: decls.slice(0, 50).map((d) => d.site),
        declarationCount: decls.length,
        candidateFiles: search.files.length,
        stubbedFiles: tree.stubbedFiles(),
      },
    }));
  } catch (err) {
    return answer(q.name, started, now, { error: `TypeScript failed: ${err instanceof Error ? err.message : String(err)}` });
  } finally {
    tree.service.dispose();
  }
}
