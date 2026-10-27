/** P009: source evidence only. No filesystem, provider, database or routine execution. */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import ts from 'typescript';
import {
  deferredSpendEvidenceIdentitySchema,
  deferredSpendFingerprint,
  type DeferredSpendCensusSelectors,
  type DeferredSpendEvidenceIdentity,
  type DeferredSpendEvidenceSlice,
  type DeferredSpendImmutable,
  type EvidenceVerdict,
} from './deferred-spend-acceptance-contract';

export type SourceCriterion = 'R001' | 'R002' | 'R005' | 'R008';
export type SourceEffect = 'transport' | 'credential' | 'schema' | 'routine' | 'lifecycle' | 'call';
export interface SourceBytes {
  readonly revision: string;
  readonly path: string;
  readonly contentHash: string;
  /** null is an unreadable member, never an empty file. */
  readonly text: string | null;
}
export interface SourceRootManifest {
  readonly root: string;
  readonly members: readonly { readonly path: string; readonly contentHash: string }[];
}
export interface DeferredSpendSourceSnapshot {
  readonly identity: DeferredSpendEvidenceIdentity;
  readonly files: readonly SourceBytes[];
  /** Exhaustive listings independently witnessed by productionRoots.contentHash. */
  readonly roots: readonly SourceRootManifest[];
  readonly packages: readonly { readonly name: string; readonly version: string; readonly manifestPath: string }[];
  readonly evidenceRefs: readonly string[];
}
export interface SourceSymbol { readonly path: string; readonly symbol: string }
export interface SourceAllowance extends SourceSymbol {
  readonly effect: SourceEffect;
  /** Exact reviewed bytes, not a module-name allowlist. */
  readonly contentHash: string;
  readonly reason: string;
  readonly evidenceRefs: readonly string[];
}
export interface SourcePositiveControl extends SourceSymbol {
  readonly id: string;
  readonly kind: 'call' | 'property' | 'literal' | 'schema' | 'routine';
  readonly value: string;
}
/** Each criterion needs its own witnessed controls. A broad green file is insufficient. */
export const DEFERRED_SPEND_SOURCE_CONTROLS = {
  R001: ['billing-reader', 'public-bigquery', 'named-parameters', 'query-byte-ceiling', 'run-parameter', 'window-start', 'window-end'],
  R002: ['connection-descriptor', 'existing-credential-ref', 'descriptor-parser', 'google-auth'],
  R005: ['existing-routine', 'spend-sweep', 'connection-schema', 'host-schema', 'operation-schema'],
  R008: ['read-only-collector'],
} as const;
export interface DeferredSpendSourceRequest {
  readonly expectedIdentity: DeferredSpendEvidenceIdentity;
  readonly entrypoints: readonly SourceSymbol[];
  readonly allowances: readonly SourceAllowance[];
  readonly controls: readonly SourcePositiveControl[];
}
export interface SourceEdge extends SourceSymbol {
  readonly line: number;
  readonly kind: 'import' | 'type-import' | 're-export' | 'dynamic-import' | 'call' | 'dispatch' | 'callback';
  readonly target: string;
  readonly resolved: boolean;
}
export interface SourceDiagnostic extends SourceSymbol {
  readonly line: number;
  readonly criterion: SourceCriterion;
  readonly effect: SourceEffect;
  readonly disposition: 'forbidden' | 'unknown' | 'baseline' | 'out-of-scope';
  readonly reason: string;
}
export interface DeferredSpendSourceCensus {
  readonly verdict: EvidenceVerdict;
  readonly identity?: DeferredSpendEvidenceIdentity;
  readonly slices: readonly DeferredSpendEvidenceSlice[];
  readonly manifest: readonly { readonly member: string; readonly contentHash: string }[];
  readonly packages: DeferredSpendSourceSnapshot['packages'];
  readonly edges: readonly SourceEdge[];
  readonly reachableSymbols: readonly string[];
  readonly diagnostics: readonly SourceDiagnostic[];
  readonly gaps: readonly string[];
}

export const deferredSpendSourceHash = (text: string): string => createHash('sha256').update(text).digest('hex');
export function deferredSpendSourceManifest(files: readonly SourceBytes[]) {
  return files.map(({ revision, path, contentHash }) => ({ member: `${revision}:${path}`, contentHash }))
    .sort((a, b) => a.member.localeCompare(b.member));
}
function freeze<T>(value: T): DeferredSpendImmutable<T> {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value as DeferredSpendImmutable<T>;
}
const canonicalPath = (path: string) => !!path && !path.startsWith('/') && !path.includes('\\') &&
  path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
const key = (path: string, symbol: string) => `${path}#${symbol}`;
const sourcePattern = /\.(?:[cm]?tsx?|jsx?)$/;
const packageName = (name: string) => name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];

/** Pure, synchronous, detached analysis of one immutable, independently selected snapshot. */
export function analyzeDeferredSpendSourceCensus(
  request: DeferredSpendSourceRequest,
  snapshot: DeferredSpendSourceSnapshot,
): DeferredSpendSourceCensus {
  const empty = (reason: string): DeferredSpendSourceCensus => freeze({
    verdict: 'unknown', slices: [], manifest: [], packages: [], edges: [], reachableSymbols: [], diagnostics: [], gaps: [reason],
  });
  const wanted = deferredSpendEvidenceIdentitySchema.safeParse(request.expectedIdentity);
  const actual = deferredSpendEvidenceIdentitySchema.safeParse(snapshot.identity);
  if (!wanted.success || !actual.success || wanted.data.subject.kind !== 'source' ||
      deferredSpendFingerprint(wanted.data) !== deferredSpendFingerprint(actual.data)) {
    return empty('invalid, non-source or mismatched independently expected identity/selectors');
  }
  // Detach before processing; neither callers nor results can rewrite the observed population.
  const input = structuredClone(snapshot);
  const identity = actual.data;
  const selectors: DeferredSpendCensusSelectors = identity.censusSelectors;
  const candidate = selectors.candidate.revision;
  const gaps: string[] = [];
  if (selectors.roots.contentHash !== deferredSpendFingerprint({ repositoryRoot: selectors.roots.repositoryRoot, workspaceRoot: selectors.roots.workspaceRoot })) gaps.push('canonical root configuration hash mismatch');
  if (selectors.projectConfiguration.contentHash !== deferredSpendFingerprint({ tsconfigs: selectors.projectConfiguration.tsconfigs, projectReferences: selectors.projectConfiguration.projectReferences })) gaps.push('project configuration population hash mismatch');
  if (selectors.migrationRegistry.contentHash !== deferredSpendFingerprint(selectors.migrationRegistry.entries)) gaps.push('migration registry population hash mismatch');
  if (identity.configurationHash !== deferredSpendFingerprint({ projectConfiguration: selectors.projectConfiguration, migrationRegistry: selectors.migrationRegistry, packages: input.packages })) gaps.push('configuration/package identity mismatch');
  const files = new Map<string, SourceBytes>();
  const expected = new Map<string, string>();
  const checked = new Set<string>();
  const changed = new Set<string>();
  const diagnostics: SourceDiagnostic[] = [];
  const edges: SourceEdge[] = [];
  const manifest = deferredSpendSourceManifest(input.files);
  if (deferredSpendFingerprint(manifest) !== identity.sourceManifestHash) gaps.push('source manifest hash mismatch');
  if (!input.evidenceRefs.length) gaps.push('missing source snapshot evidence');
  for (const file of input.files) {
    const member = `${file.revision}:${file.path}`;
    if (!canonicalPath(file.path) || ![candidate, selectors.base.revision].includes(file.revision)) gaps.push(`invalid source member: ${member}`);
    if (files.has(member)) gaps.push(`duplicate source member: ${member}`);
    files.set(member, file);
  }
  const requireFile = (revision: string, entry: { readonly path: string; readonly contentHash: string }) => {
    const member = `${revision}:${entry.path}`;
    if (expected.has(member) && expected.get(member) !== entry.contentHash) gaps.push(`conflicting selector hashes: ${member}`);
    expected.set(member, entry.contentHash);
  };
  for (const root of selectors.productionRoots) {
    const matches = input.roots.filter((entry) => entry.root === root.path);
    if (matches.length !== 1 || !matches[0].members.length) { gaps.push(`missing, duplicate or empty production root: ${root.path}`); continue; }
    const members = matches[0].members;
    if (deferredSpendFingerprint(members) !== root.contentHash) gaps.push(`production root listing hash mismatch: ${root.path}`);
    if (new Set(members.map((entry) => entry.path)).size !== members.length) gaps.push(`duplicate root member: ${root.path}`);
    for (const member of members) {
      if (!(member.path === root.path || member.path.startsWith(`${root.path}/`))) gaps.push(`root path escape: ${member.path}`);
      requireFile(candidate, member);
    }
  }
  for (const change of selectors.changedPaths.entries) {
    if ('old' in change) requireFile(selectors.base.revision, change.old);
    if ('new' in change) { requireFile(candidate, change.new); changed.add(change.new.path); }
  }
  const configuration = [...selectors.projectConfiguration.tsconfigs, ...selectors.projectConfiguration.projectReferences];
  for (const entry of [...configuration, ...selectors.migrationRegistry.entries]) requireFile(candidate, entry);
  if (selectors.migrationRegistry.revision !== candidate) gaps.push('migration registry revision differs from candidate');
  for (const [member, hash] of expected) {
    const file = files.get(member);
    if (!file || file.text === null) gaps.push(`missing or unreadable source: ${member}`);
    else if (file.contentHash !== hash || deferredSpendSourceHash(file.text) !== hash) gaps.push(`source byte hash mismatch: ${member}`);
    else checked.add(member);
  }
  // Additional source is never silently accepted outside the independently selected population.
  for (const member of files.keys()) if (!expected.has(member)) gaps.push(`unselected source member: ${member}`);
  const texts = new Map<string, string>();
  for (const [member, file] of files) if (file.revision === candidate && checked.has(member) && file.text !== null) texts.set(file.path, file.text);
  for (const path of texts.keys()) if (!sourcePattern.test(path) && !/\.sql$/.test(path) &&
    !configuration.some((entry) => entry.path === path) && !input.packages.some((entry) => entry.manifestPath === path)) gaps.push(`unsupported source/configuration format: ${path}`);
  const abs = (path: string) => posix.join('/source', path);
  const rel = (path: string) => posix.relative('/source', path);
  const read = (path: string) => texts.get(rel(path));
  const exists = (path: string) => texts.has(rel(path));
  const directories = new Set<string>(['/source']);
  for (const path of texts.keys()) {
    let directory = posix.dirname(abs(path));
    while (directory !== '/' && !directories.has(directory)) { directories.add(directory); directory = posix.dirname(directory); }
  }
  const directoryExists = (path: string) => directories.has(path.replace(/\/$/, ''));
  const configs: { path: string; options: ts.CompilerOptions }[] = [];
  for (const config of configuration) {
    const text = texts.get(config.path);
    if (text === undefined) continue;
    const parsed = ts.parseConfigFileTextToJson(config.path, text);
    if (parsed.error) { gaps.push(`unparseable project configuration: ${config.path}`); continue; }
    const result = ts.parseJsonConfigFileContent(parsed.config, {
      useCaseSensitiveFileNames: true, readFile: read, fileExists: exists,
      readDirectory: () => [...texts.keys()].filter((path) => sourcePattern.test(path)).map(abs),
    }, posix.dirname(abs(config.path)), undefined, abs(config.path));
    if (result.errors.some((error) => error.code !== 18003)) gaps.push(`unresolved project configuration: ${config.path}`);
    configs.push({ path: config.path, options: result.options });
  }
  const optionsFor = (path: string) => [...configs].sort((a, b) => b.path.length - a.path.length)
    .find((entry) => posix.dirname(entry.path) === '.' || path.startsWith(`${posix.dirname(entry.path)}/`))?.options ?? {};
  const packageVersions = new Map<string, string>();
  for (const pkg of input.packages) {
    try {
      const metadata = JSON.parse(texts.get(pkg.manifestPath) ?? 'null');
      if (!pkg.version || metadata?.name !== pkg.name || metadata?.version !== pkg.version || packageVersions.has(pkg.name)) throw Error();
      packageVersions.set(pkg.name, pkg.version);
    } catch { gaps.push(`unwitnessed package version: ${pkg.name}`); }
  }
  const resolveModule = (specifier: string, containing: string) => {
    const result = ts.resolveModuleName(specifier, containing, optionsFor(rel(containing)), {
      fileExists: exists, readFile: read, directoryExists, getCurrentDirectory: () => '/source', realpath: (path) => path,
    }).resolvedModule;
    return result;
  };
  const host: ts.CompilerHost = {
    getSourceFile: (path, languageVersion) => {
      const text = read(path);
      return text === undefined ? undefined : ts.createSourceFile(path, text, languageVersion, true);
    },
    getDefaultLibFileName: () => '/source/__no_lib__.d.ts', writeFile: () => { throw Error('source census cannot write'); },
    getCurrentDirectory: () => '/source', getDirectories: () => [], fileExists: exists, readFile: read, directoryExists,
    getCanonicalFileName: (path) => path, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
    resolveModuleNames: (names, containing) => names.map((name) => resolveModule(name, containing)),
  };
  const program = ts.createProgram([...texts.keys()].filter((path) => sourcePattern.test(path)).map(abs), {
    ...optionsFor(''), noLib: true, noResolve: false, allowJs: true,
  }, host);
  const checker = program.getTypeChecker();
  const functions = new Map<ts.Node, string>();
  const nodes = new Map<string, ts.Node>();
  const functionName = (node: ts.Node): string => {
    if (ts.isConstructorDeclaration(node) && ts.isClassDeclaration(node.parent)) return `${node.parent.name?.text ?? '<anonymous>'}.constructor`;
    if ('name' in node && node.name && ts.isIdentifier(node.name as ts.Node)) {
      const name = (node.name as ts.Identifier).text;
      return ts.isClassDeclaration(node.parent) && node.parent.name ? `${node.parent.name.text}.${name}` : name;
    }
    if (ts.isVariableDeclaration(node.parent) || ts.isPropertyAssignment(node.parent)) return node.parent.name.getText();
    return `<callback@${node.getStart()}>`;
  };
  const sourceFiles = program.getSourceFiles().filter((file) => texts.has(rel(file.fileName)));
  for (const file of sourceFiles) {
    const path = rel(file.fileName);
    nodes.set(key(path, '<module>'), file);
    const visit = (node: ts.Node) => {
      if (ts.isFunctionLike(node) && 'body' in node && node.body) {
        const id = key(path, functionName(node));
        if (nodes.has(id)) gaps.push(`ambiguous symbol: ${id}`);
        nodes.set(id, node); functions.set(node, id);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (program.getSyntacticDiagnostics(file).length) gaps.push(`source parse failure: ${path}`);
  }
  const baselineFunctions = new Map<string, string>();
  for (const change of selectors.changedPaths.entries) if ('old' in change && 'new' in change) {
    const prior = files.get(`${selectors.base.revision}:${change.old.path}`);
    if (!prior?.text || !checked.has(`${selectors.base.revision}:${change.old.path}`)) continue;
    const parsed = ts.createSourceFile(change.old.path, prior.text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isFunctionLike(node) && 'body' in node && node.body) baselineFunctions.set(key(change.new.path, functionName(node)), node.getText(parsed));
      ts.forEachChild(node, visit);
    };
    visit(parsed);
  }
  const owner = (node: ts.Node): string => {
    let current: ts.Node | undefined = node;
    while (current) { const id = functions.get(current); if (id) return id; current = current.parent; }
    return key(rel(node.getSourceFile().fileName), '<module>');
  };
  const site = (node: ts.Node): SourceSymbol & { line: number } => ({
    path: rel(node.getSourceFile().fileName), symbol: owner(node).split('#').slice(1).join('#'),
    line: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1,
  });
  const declaration = (node: ts.Node, seen = new Set<ts.Node>()): string | undefined => {
    if (seen.has(node)) return; seen.add(node);
    if (functions.has(node)) return functions.get(node);
    if (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) return node.initializer ? declaration(node.initializer, seen) : undefined;
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol);
    for (const value of symbol?.declarations ?? []) {
      const id = declaration(value, seen); if (id) return id;
    }
  };
  const literal = (node: ts.Node | undefined, seen = new Set<ts.Node>()): string | undefined => {
    if (!node || seen.has(node)) return; seen.add(node);
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return literal(node.expression, seen);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = literal(node.left, new Set(seen)), right = literal(node.right, new Set(seen));
      return left === undefined || right === undefined ? undefined : left + right;
    }
    if (ts.isIdentifier(node)) {
      const value = checker.getSymbolAtLocation(node)?.valueDeclaration;
      if (value && ts.isVariableDeclaration(value)) return literal(value.initializer, seen);
    }
  };
  const adjacency = new Map<string, Set<string>>();
  const link = (node: ts.Node, target: string, kind: SourceEdge['kind'], resolved: boolean) => {
    edges.push({ ...site(node), target, kind, resolved });
    if (resolved && nodes.has(target)) {
      const set = adjacency.get(owner(node)) ?? new Set<string>(); set.add(target); adjacency.set(owner(node), set);
    }
  };
  const calls: ts.CallExpression[] = [];
  const resolvedCalls = new Set<ts.CallExpression>();
  const constructors: ts.NewExpression[] = [];
  const registrations = new Map<string, string[]>();
  const tokens: { node: ts.Node; kind: SourcePositiveControl['kind']; value: string }[] = [];
  for (const file of sourceFiles) {
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const spec = node.moduleSpecifier.text;
        const target = resolveModule(spec, file.fileName);
        const typeOnly = ts.isImportDeclaration(node) ? !!node.importClause?.isTypeOnly ||
          (!!node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.length > 0 && node.importClause.namedBindings.elements.every((entry) => entry.isTypeOnly)) : node.isTypeOnly ||
          (!!node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every((entry) => entry.isTypeOnly));
        const external = spec.startsWith('node:') || packageVersions.has(packageName(spec));
        link(node, target ? key(rel(target.resolvedFileName), '<module>') : spec, typeOnly ? 'type-import' : ts.isExportDeclaration(node) ? 're-export' : 'import', !!target || external);
      }
      if (ts.isCallExpression(node)) {
        calls.push(node);
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText() === 'require') {
          const spec = literal(node.arguments[0]);
          const target = spec ? resolveModule(spec, file.fileName) : undefined;
          link(node, target ? key(rel(target.resolvedFileName), '<module>') : spec ?? '<dynamic>', 'dynamic-import', !!target);
        } else {
          const signature = checker.getResolvedSignature(node)?.declaration;
          const target = (signature && functions.get(signature)) ?? declaration(node.expression);
          if (target) resolvedCalls.add(node);
          link(node, target ?? node.expression.getText(), 'call', !!target);
          for (const arg of node.arguments) { const callback = declaration(arg); if (callback) link(node, callback, 'callback', true); }
          tokens.push({ node, kind: 'call', value: node.expression.getText() });
          if (/^(?:registerSystemAction|registerRoutine|seedRoutine)$/.test(node.expression.getText())) {
            const name = literal(node.arguments[0]), handler = node.arguments[1] && declaration(node.arguments[1]);
            if (name && handler) registrations.set(name, [...(registrations.get(name) ?? []), handler]);
            tokens.push({ node, kind: 'routine', value: name ?? '<dynamic>' });
          }
        }
      }
      if (ts.isNewExpression(node)) {
        constructors.push(node);
        const signature = checker.getResolvedSignature(node)?.declaration;
        const target = signature && functions.get(signature);
        link(node, target ?? node.expression.getText(), 'call', !!target);
      }
      if (ts.isStringLiteralLike(node)) tokens.push({ node, kind: 'literal', value: node.text });
      if (ts.isPropertyAccessExpression(node)) tokens.push({ node, kind: 'property', value: node.getText() });
      if (ts.isPropertyAssignment(node)) tokens.push({ node, kind: 'property', value: node.name.getText() });
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  for (const call of calls) if (/^(?:dispatch|dispatchSystemAction|runSystemAction)$/.test(call.expression.getText())) {
    const name = literal(call.arguments[0]);
    const handlers = name ? registrations.get(name) : undefined;
    if (handlers?.length === 1) { link(call, handlers[0], 'dispatch', true); resolvedCalls.add(call); }
    else link(call, `dispatch:${name ?? '<dynamic>'}`, 'dispatch', false);
  }
  const reachable = new Set<string>();
  const queue = request.entrypoints.map((entry) => key(entry.path, entry.symbol));
  if (!queue.length) gaps.push('empty settlement entrypoints');
  while (queue.length) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    if (!nodes.has(id)) { gaps.push(`missing settlement symbol: ${id}`); continue; }
    reachable.add(id);
    queue.push(...(adjacency.get(id) ?? []));
    // Importing a module executes its initializer, but never its type-only imports.
    const module = key(id.split('#')[0], '<module>');
    if (id !== module) queue.push(module);
    if (id === module) for (const edge of edges) if (edge.path === id.split('#')[0] && ['import', 're-export', 'dynamic-import'].includes(edge.kind) && edge.resolved && nodes.has(edge.target)) queue.push(edge.target);
  }
  const allowed = (node: ts.Node, effect: SourceEffect) => request.allowances.some((entry) => {
    const here = site(node);
    return entry.path === here.path && entry.symbol === here.symbol && entry.effect === effect &&
      entry.contentHash === files.get(`${candidate}:${here.path}`)?.contentHash && !!entry.reason.trim() && entry.evidenceRefs.length > 0;
  });
  const inScope = (node: ts.Node) => reachable.has(owner(node)) || (changed.has(site(node).path) &&
    baselineFunctions.get(owner(node)) !== nodes.get(owner(node))?.getText());
  const diagnose = (node: ts.Node, criterion: SourceCriterion, effect: SourceEffect, reason: string, uncertain = false) => {
    const here = site(node);
    const scoped = inScope(node);
    const prohibited = /private billing transport|prohibited settlement effect/.test(reason);
    const disposition = !scoped ? 'out-of-scope' : uncertain ? 'unknown' : !prohibited && allowed(node, effect) ? 'baseline' : 'forbidden';
    diagnostics.push({ ...here, criterion, effect, disposition, reason });
    if (disposition === 'unknown') gaps.push(`${here.path}:${here.line} ${here.symbol}: ${reason}`);
  };
  for (const edge of edges) if (!edge.resolved && ['import', 'type-import', 're-export', 'dynamic-import', 'dispatch'].includes(edge.kind)) gaps.push(`${edge.path}:${edge.line}: unresolved ${edge.kind} ${edge.target}`);
  const calleeName = (expression: ts.Expression, seen = new Set<ts.Node>()): string => {
    if (seen.has(expression)) return expression.getText(); seen.add(expression);
    if (ts.isIdentifier(expression)) {
      const symbol = checker.getSymbolAtLocation(expression);
      for (const decl of symbol?.declarations ?? []) {
        if (ts.isImportSpecifier(decl)) return (decl.propertyName ?? decl.name).text;
        if (ts.isVariableDeclaration(decl) && decl.initializer) return calleeName(decl.initializer, seen);
      }
    }
    return expression.getText();
  };
  const endpointValue = (node: ts.Node | undefined) => {
    const full = node && literal(node);
    if (full !== undefined) return full;
    if (node && ts.isTemplateExpression(node)) {
      let prefix = node.head.text;
      for (const span of node.templateSpans) {
        const part = literal(span.expression);
        if (part === undefined) break;
        prefix += part + span.literal.text;
      }
      // A known public origin followed by a slash cannot be changed by a path interpolation.
      return /^https:\/\/bigquery\.googleapis\.com\//.test(prefix) ? prefix : undefined;
    }
  };
  const endpointLabel = (endpoint: string) => {
    try { const url = new URL(endpoint); return `${url.origin}${url.pathname}`; } catch { return '<invalid endpoint>'; }
  };
  for (const call of calls) {
    const name = calleeName(call.expression);
    if (/BillingData|graphql|mintCredential|createCredential|replayLifecycle|destroyHost|destroyWorkspaceHost|emitGate|transitionGate/i.test(name)) {
      diagnose(call, /BillingData|graphql/i.test(name) ? 'R001' : 'R008', /BillingData|graphql/i.test(name) ? 'transport' : 'lifecycle', `prohibited settlement effect: ${name}`);
    } else if (/^(?:fetch|fetchGcpApiJson|request|axios(?:\.[a-z]+)?)$/.test(name)) {
      const endpoint = endpointValue(call.arguments[0]);
      if (endpoint && /console\.cloud\.google|BillingData|graphql/i.test(endpoint)) diagnose(call, 'R001', 'transport', `private billing transport: ${endpointLabel(endpoint)}`);
      else if (!endpoint || !/^https:\/\/bigquery\.googleapis\.com\//.test(endpoint)) diagnose(call, 'R001', 'transport', 'unresolved or unsupported settlement endpoint', true);
      else if (!allowed(call, 'transport')) diagnose(call, 'R001', 'transport', 'public BigQuery transport requires exact reviewed auth/query seam', true);
      else diagnose(call, 'R001', 'transport', `public BigQuery baseline: ${endpointLabel(endpoint)}`);
    } else if (/writeFile|appendFile|keychain|setPassword|saveCredential|storeCredential|setSecret/i.test(name)) {
      diagnose(call, 'R002', 'credential', `credential/storage sink requires baseline justification: ${name}`);
    } else if (/setInterval|setTimeout|schedule|registerSystemAction|registerRoutine|seedRoutine/i.test(name)) {
      diagnose(call, 'R005', 'routine', `routine/timer registration requires exact existing identity: ${name}`);
    } else if (call.expression.kind !== ts.SyntaxKind.ImportKeyword && name !== 'require' &&
      !resolvedCalls.has(call) &&
      !allowed(call, 'call')) diagnose(call, 'R008', 'call', `unresolved effect of call: ${name}`, true);
  }
  for (const constructor of constructors) if (!checker.getResolvedSignature(constructor)?.declaration || !functions.has(checker.getResolvedSignature(constructor)!.declaration!)) {
    diagnose(constructor, /Credential|Secret|Keychain/i.test(constructor.expression.getText()) ? 'R002' : 'R008', 'call', `unresolved constructor effect: ${constructor.expression.getText()}`, true);
  }
  // Separate SQL tokens from data before recognizing effects. Preserve offsets/newlines so
  // quoted table identities and diagnostics still refer to the original source bytes.
  const inspectSql = (path: string, sql: string, node?: ts.Node) => {
    const masked = sql.split('');
    const mask = (start: number, end: number, identifier = false) => {
      for (let i = start; i < end; i++) if (sql[i] !== '\n' && sql[i] !== '\r') masked[i] = identifier ? 'x' : ' ';
    };
    for (let i = 0; i < sql.length;) {
      const start = i;
      if (sql.startsWith('--', i)) {
        while (i < sql.length && sql[i] !== '\n') i++;
        mask(start, i);
      } else if (sql.startsWith('/*', i)) {
        let depth = 1; i += 2;
        while (i < sql.length && depth) {
          if (sql.startsWith('/*', i)) { depth++; i += 2; }
          else if (sql.startsWith('*/', i)) { depth--; i += 2; }
          else i++;
        }
        if (depth) gaps.push(`${path}: unterminated SQL comment`);
        mask(start, i);
      } else if (sql[i] === "'" || sql[i] === '"') {
        const quote = sql[i++], identifier = quote === '"';
        const escaped = !identifier && start > 0 && /e/i.test(sql[start - 1]) && (start < 2 || !/[\w$]/.test(sql[start - 2]));
        let closed = false;
        while (i < sql.length) {
          if (sql[i] === quote) {
            if (sql[i + 1] === quote) { i += 2; continue; }
            i++; closed = true; break;
          }
          if (!identifier && sql[i] === '\\') {
            if (escaped) { i = Math.min(i + 2, sql.length); continue; }
            gaps.push(`${path}: SQL string escape semantics require review`);
          }
          i++;
        }
        if (!closed) gaps.push(`${path}: unterminated SQL quoted token`);
        mask(start, i, identifier);
      } else if (sql[i] === '$' && (i === 0 || !/[\w$]/.test(sql[i - 1]))) {
        const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
        if (!delimiter) { i++; continue; }
        const end = sql.indexOf(delimiter, i + delimiter.length);
        if (end < 0) gaps.push(`${path}: unterminated SQL dollar quote`);
        i = end < 0 ? sql.length : end + delimiter.length;
        mask(start, i);
      } else i++;
    }
    const stripped = masked.join('');
    if (node && /\b(?:INSERT\s+INTO|UPDATE\s+[\w."]+\s+SET|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+TABLE)\b/i.test(stripped)) diagnose(node, 'R008', 'call', 'SQL mutation reachable from the source/acceptance boundary');
    if (!node && /\b(?:INSERT\s+INTO|UPDATE\s+[\w."]+\s+SET|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+TABLE)\b/i.test(stripped)) {
      const baseline = request.allowances.some((entry) => entry.path === path && entry.symbol === '<schema>' && entry.effect === 'schema' && entry.contentHash === files.get(`${candidate}:${path}`)?.contentHash && entry.reason.trim() && entry.evidenceRefs.length);
      diagnostics.push({ path, symbol: '<schema>', line: 1, criterion: 'R005', effect: 'schema', disposition: baseline ? 'baseline' : 'forbidden', reason: 'active migration contains a SQL mutation outside the reviewed baseline' });
    }
    if (/\b(?:EXECUTE|DO)\b/i.test(stripped)) gaps.push(`${path}: dynamic SQL population cannot be resolved`);
    for (const match of stripped.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."-]+)/gi)) {
      const nameOffset = match.index + match[0].lastIndexOf(match[1]);
      const tableName = sql.slice(nameOffset, nameOffset + match[1].length);
      const symbol = node ? site(node).symbol : '<schema>';
      const line = node ? site(node).line : stripped.slice(0, match.index).split('\n').length;
      const scoped = changed.has(path) || selectors.migrationRegistry.entries.some((entry) => entry.path === path);
      const baseline = request.allowances.some((entry) => entry.path === path && entry.symbol === symbol && entry.effect === 'schema' &&
        entry.contentHash === files.get(`${candidate}:${path}`)?.contentHash && !!entry.reason.trim() && entry.evidenceRefs.length);
      diagnostics.push({ path, symbol, line, criterion: 'R005', effect: 'schema', disposition: !scoped ? 'out-of-scope' : baseline ? 'baseline' : 'forbidden', reason: `schema table: ${tableName}` });
      if (node) tokens.push({ node, kind: 'schema', value: tableName });
    }
  };
  for (const [path, text] of texts) if (/\.sql$/.test(path)) {
    // We do not have a complete PostgreSQL parser. Unreviewed raw SQL is never a clean
    // negative, even when a recognizable counterexample was already diagnosed above.
    if (!request.allowances.some((entry) => entry.path === path && entry.symbol === '<schema>' && entry.effect === 'schema' && entry.contentHash === deferredSpendSourceHash(text) && entry.reason.trim() && entry.evidenceRefs.length)) gaps.push(`unreviewed active SQL: ${path}`);
    inspectSql(path, text);
  }
  for (const call of calls) if (/(?:query|execute|sql)$/i.test(calleeName(call.expression))) {
    const sql = literal(call.arguments[0]);
    if (sql === undefined) {
      if (inScope(call)) gaps.push(`${site(call).path}:${site(call).line}: unresolved SQL text`);
    } else inspectSql(site(call).path, sql, call);
  }
  for (const file of sourceFiles) {
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && /^(?:accessToken|refreshToken|privateKey|clientSecret|password|token)$/.test(node.name.getText().replace(/['"]/g, ''))) diagnose(node, 'R002', 'credential', `credential bytes in source object: ${node.name.getText()}`);
      if (ts.isTaggedTemplateExpression(node)) {
        if (ts.isNoSubstitutionTemplateLiteral(node.template)) inspectSql(rel(file.fileName), node.template.text, node);
        else if (inScope(node)) gaps.push(`${site(node).path}:${site(node).line}: interpolated SQL/template effect requires review`);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  const controlIds = new Set<string>();
  for (const control of request.controls) {
    if (controlIds.has(control.id)) gaps.push(`duplicate positive control: ${control.id}`);
    controlIds.add(control.id);
    const matches = tokens.some((token) => token.kind === control.kind && token.value === control.value &&
      site(token.node).path === control.path && site(token.node).symbol === control.symbol && reachable.has(owner(token.node)));
    const sqlMatch = control.kind === 'schema' && diagnostics.some((entry) => entry.path === control.path && entry.symbol === control.symbol &&
      entry.effect === 'schema' && entry.disposition === 'baseline' && entry.reason === `schema table: ${control.value}`);
    if (!matches && !sqlMatch) gaps.push(`unwitnessed positive control: ${control.id}`);
  }
  const population = [...expected.keys()].sort();
  const commonGaps = [...new Set(gaps)];
  const slices: DeferredSpendEvidenceSlice[] = Object.entries(DEFERRED_SPEND_SOURCE_CONTROLS).map(([criterion, controls]) => {
    const missing = controls.filter((id) => !controlIds.has(id)).map((id) => `missing positive control: ${id}`);
    const violations = diagnostics.filter((entry) => entry.criterion === criterion && entry.disposition === 'forbidden')
      .map((entry) => ({ member: `${candidate}:${entry.path}`, reason: `${entry.path}:${entry.line} ${entry.symbol}: ${entry.reason}`, evidenceRefs: [...input.evidenceRefs] }));
    const sliceGaps = [...commonGaps, ...missing];
    return {
      id: `source-${criterion.toLowerCase()}`, verdict: violations.length ? 'fail' : sliceGaps.length ? 'unknown' : 'pass',
      evidenceRefs: [...input.evidenceRefs], violations,
      ...(sliceGaps.length ? { reason: sliceGaps.join('; ') } : {}),
      coverage: {
        state: sliceGaps.length ? 'partial' : 'complete', population, checked: population.filter((member) => checked.has(member)),
        notChecked: population.filter((member) => !checked.has(member)), notApplicable: [], residue: [], gaps: sliceGaps,
        snapshotRef: identity.observation.snapshot.id, pageRefs: [...input.evidenceRefs], emptyPopulationEvidenceRefs: [],
      },
    };
  });
  return freeze({
    verdict: slices.some((slice) => slice.verdict === 'fail') ? 'fail' : slices.some((slice) => slice.verdict === 'unknown') ? 'unknown' : 'pass',
    identity, slices, manifest, packages: input.packages, edges, reachableSymbols: [...reachable].sort(), diagnostics, gaps: commonGaps,
  });
}
