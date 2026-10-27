import { createHash } from 'node:crypto';
import * as ts from 'typescript';
import { AST_FINGERPRINT_VERSION, fingerprintTree, type TreeAdapter } from '../../../../libs/generic/ast-fingerprint/src/index';
import type { PushSnapshot } from './push-snapshot';
import type { CodeWorkingSet } from './working-set';
import { CLONE_NEAR_POLICY, compareCloneNear, fingerprintCloneNear, type CloneNearFingerprint } from './clone-near';

export const CLONE_MIN_MASS = 80;
export const CLONE_MAX_SOURCE_BYTES = 1_500_000;
export const CLONE_NORMALIZATION_VERSION = `typescript-${ts.version}:${AST_FINGERPRINT_VERSION}`;
export type CloneKind = 'exact' | 'renamed';
export interface CloneClassification { test: boolean; vendored: boolean; retired: boolean }
export interface CloneFunction {
  id: string; path: string; line: number; column: number; start: number; end: number;
  name: string; signature: string; mass: number; exact: string; renamed: string;
  blobSha: string; classification: CloneClassification;
  /** For an anonymous function: the nearest named enclosing symbol (or the callee it
   * is passed to), so a filed finding can name a member a reader can navigate to.
   * Absent for named functions, whose own name is already that symbol. */
  enclosing?: string;
}
/** The symbol a person navigates to for this member — never the bare `<anon>`. */
export const cloneMemberSymbol = (fn: Pick<CloneFunction, 'name' | 'enclosing'>) =>
  fn.name !== '<anon>' ? fn.name : fn.enclosing ?? 'anonymous function at module scope';
export interface CloneFile {
  path: string; blobSha: string | null; sha256: string | null;
  status: 'indexed' | 'syntax-error' | 'excluded' | 'unavailable';
  diagnostics: readonly { start: number; length: number; message: string }[];
  functions: readonly CloneFunction[];
}
export interface CloneFamily {
  id: string; version: string; kind: CloneKind; fingerprint: string; members: readonly CloneFunction[];
}
export interface CloneSource { path: string; source: string; blobSha?: string }
export interface CloneFilter {
  includeClassified?: boolean;
  /** The frozen historical probe excluded test filenames, but retained rigs
   * under __tests__. Replay its exact vendor/retired-only postfilter explicitly.
   */
  includeTests?: boolean;
}

// Instance-owned function records carry private shapes without serializing AST
// trees in public source inventories or retaining them in a global cache.
const nearFingerprint = Symbol('clone-near');
type NearFunction = CloneFunction & { [nearFingerprint]?: CloneNearFingerprint };
export interface CloneNearMatch { member: CloneFunction; score: number }

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const byLocation = (a: CloneFunction, b: CloneFunction) => compare(a.path, b.path) || a.line - b.line || a.column - b.column || compare(a.name, b.name);
const sha256 = (source: string) => createHash('sha256').update(source).digest('hex');
export const cloneBlobSha = (source: string) => createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');

export function classifyClonePath(path: string): CloneClassification {
  return {
    test: /(?:\.(?:test|spec)\.tsx?$)|(?:^|\/)(?:__tests__|__fixtures__|__mocks__)(?:\/|$)/.test(path),
    // env-sidecars/ holds per-environment generated copies of shared sidecar code
    // (code-cleanup-campaigns-2026-10-26 P-002 precision sample): derive-and-sync, not consolidate.
    vendored: /(?:^|\/)node_modules\/|^templates\/|\/template-kit\/|(?:^|\/)env-sidecars\//.test(path),
    retired: /(?:^|\/)_retired\/|^apps\/operator\/app\//.test(path),
  };
}
function checkedPath(path: string): string {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new Error('Clone source requires a repository-relative POSIX file path');
  }
  return path;
}
const excludedSource = (path: string) => !/\.tsx?$/.test(path) || /\.d\.ts$|\.gen\.tsx?$/.test(path)
  || /(?:^|\/)(?:dist|dist-host|build|coverage|generated|\.materialized|sidecar)(?:\/|$)/.test(path);
const literalKinds = new Set([ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NumericLiteral, ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail, ts.SyntaxKind.RegularExpressionLiteral]);
const adapter: TreeAdapter<ts.Node> = {
  kind: node => node.kind,
  atom: node => ts.isIdentifier(node) || ts.isPrivateIdentifier(node)
    ? { exact: `I:${node.text}`, normalized: 'I' }
    : literalKinds.has(node.kind) ? { exact: `L:${node.getText()}`, normalized: 'L' } : null,
  forEachChild: (node, visit) => { ts.forEachChild(node, visit); },
};
/** The archived probe's eligible bodies, intentionally versioned and unchanged.
 * Expression-bodied arrows/overload declarations have no block and are not this population.
 */
function hasCloneBody(node: ts.Node): node is ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction
  | ts.FunctionExpression | ts.ConstructorDeclaration | ts.GetAccessorDeclaration {
  return (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node)
    || ts.isFunctionExpression(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessor(node))
    && !!node.body && ts.isBlock(node.body);
}

const declaredName = (node: ts.Node): string | null => {
  const named = node as ts.Node & { name?: ts.Node };
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)
    || ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isVariableDeclaration(node)
    || ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node) || ts.isGetAccessor(node)
    || ts.isSetAccessor(node)) && named.name && (ts.isIdentifier(named.name) || ts.isStringLiteral(named.name)
    || ts.isPrivateIdentifier(named.name))) return named.name.text;
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  return null;
};
/** Nearest navigable name for an anonymous function: the closest named enclosing
 * declaration, qualified by its own enclosing class/function (`Outer.method`), or the
 * callee it is passed to when nothing encloses it (`describe(…) callback`). */
function enclosingSymbol(fn: ts.Node): string | null {
  // A constructor or `#private` method is named by its declaration even though the
  // clone label keeps `<anon>`: qualify it by its class and stop.
  const own = declaredName(fn);
  const parts: string[] = [];
  let callee: string | null = null;
  for (let node = fn.parent; node && !ts.isSourceFile(node); node = node.parent) {
    if (!own && !callee && !parts.length && ts.isCallExpression(node)
      && node.arguments.some(arg => arg.pos <= fn.pos && fn.end <= arg.end)) {
      const target = node.expression;
      callee = ts.isIdentifier(target) ? target.text : ts.isPropertyAccessExpression(target) ? target.name.text : null;
    }
    const name = declaredName(node);
    if (name) parts.unshift(name);
    if (parts.length >= (own ? 1 : 2)) break;
  }
  const scope = parts.join('.');
  if (own) return scope ? `${scope}.${own}` : own;
  if (callee) return scope ? `${scope} › ${callee}(…) callback` : `${callee}(…) callback`;
  return scope ? `${scope} › anonymous function` : null;
}

export function extractCloneFile(input: CloneSource, minMass = CLONE_MIN_MASS, includeNear = true): CloneFile {
  const path = checkedPath(input.path), blobSha = cloneBlobSha(input.source);
  if (input.blobSha !== undefined && input.blobSha !== blobSha) throw new Error(`Clone blob identity mismatch: ${path}`);
  const base = { path, blobSha, sha256: sha256(input.source), diagnostics: [], functions: [] };
  if (excludedSource(path) || Buffer.byteLength(input.source) > CLONE_MAX_SOURCE_BYTES) return { ...base, status: 'excluded' };
  const source = ts.createSourceFile(path, input.source, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics;
  if (diagnostics.length) return { ...base, status: 'syntax-error', diagnostics: diagnostics.map(d => ({
    start: d.start ?? 0, length: d.length ?? 0, message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
  })) };
  const functions: CloneFunction[] = [];
  const classification = classifyClonePath(path);
  const visit = (node: ts.Node) => {
    if (hasCloneBody(node)) {
      const body = node.body!;
      const fp = fingerprintTree(body, adapter);
      if (fp.mass >= minMass) {
        let name = node.name && ts.isIdentifier(node.name) ? node.name.text : '';
        if (!name && (ts.isVariableDeclaration(node.parent) || ts.isPropertyAssignment(node.parent))
          && ts.isIdentifier(node.parent.name)) name = node.parent.name.text;
        const start = node.getStart(source), position = source.getLineAndCharacterOfPosition(start);
        const fn: CloneFunction = { id: `${path}:${start}`, path, start, end: node.end,
          line: position.line + 1, column: position.character + 1, name: name || '<anon>',
          signature: input.source.slice(start, body.getStart(source)).replace(/\s+/g, ' ').trim().slice(0, 300),
          mass: fp.mass, exact: fp.exact, renamed: fp.normalized, blobSha, classification };
        if (!name) { const enclosing = enclosingSymbol(node); if (enclosing) fn.enclosing = enclosing; }
        if (includeNear) Object.defineProperty(fn, nearFingerprint, { value: fingerprintCloneNear(body) });
        functions.push(fn);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { ...base, status: 'indexed', functions };
}

/** Instance-scoped, off-hook index. No timers, filesystem scans or process singleton.
 * Replacement is atomic: parse first, then remove every old contribution and publish.
 */
export class CloneIndex {
  readonly minMass: number;
  /** Exact/renamed census consumers can omit the independent near-copy index. */
  readonly includeNear: boolean;
  private readonly files = new Map<string, CloneFile>();
  private readonly buckets = { exact: new Map<string, Map<string, CloneFunction>>(), renamed: new Map<string, Map<string, CloneFunction>>() };
  private readonly nearBands = new Map<string, Map<string, CloneFunction>>();
  private generation = 0;

  constructor(options: { minMass?: number; includeNear?: boolean } = {}) {
    this.minMass = options.minMass ?? CLONE_MIN_MASS;
    this.includeNear = options.includeNear ?? true;
    if (!Number.isSafeInteger(this.minMass) || this.minMass < 1) throw new Error('Clone minMass must be a positive integer');
  }
  get version(): string { return `${CLONE_NORMALIZATION_VERSION}:floor-${this.minMass}:revision-${this.generation}`; }
  get size(): number { return this.files.size; }
  getFile(path: string): CloneFile | undefined { return this.files.get(path); }
  getFiles(): readonly CloneFile[] { return [...this.files.values()].sort((a, b) => compare(a.path, b.path)); }

  update(input: CloneSource): { changed: boolean; file: CloneFile } {
    const path = checkedPath(input.path), blob = cloneBlobSha(input.source);
    if (input.blobSha !== undefined && input.blobSha !== blob) throw new Error(`Clone blob identity mismatch: ${path}`);
    const old = this.files.get(path);
    if (old?.blobSha === blob) return { changed: false, file: old };
    const file = extractCloneFile(input, this.minMass, this.includeNear);
    this.replace(file);
    return { changed: true, file };
  }
  remove(path: string): boolean {
    const previous = this.files.get(checkedPath(path));
    if (!previous) return false;
    for (const fn of previous.functions) {
      for (const kind of ['exact', 'renamed'] as const) {
        const bucket = this.buckets[kind].get(fn[kind]);
        bucket?.delete(fn.id);
        if (!bucket?.size) this.buckets[kind].delete(fn[kind]);
      }
      for (const band of (fn as NearFunction)[nearFingerprint]?.bands ?? []) {
        const bucket = this.nearBands.get(band);
        bucket?.delete(fn.id);
        if (!bucket?.size) this.nearBands.delete(band);
      }
    }
    this.files.delete(path); this.generation++;
    return true;
  }
  unavailable(path: string, reason?: string): void {
    this.replace({ path: checkedPath(path), status: 'unavailable', blobSha: null, sha256: null,
      diagnostics: reason ? [{ start: 0, length: 0, message: reason.slice(0, 500) }] : [], functions: [] });
  }
  private replace(file: CloneFile): void {
    this.remove(file.path);
    this.files.set(file.path, file);
    for (const fn of file.functions) {
      for (const kind of ['exact', 'renamed'] as const) {
        const bucket = this.buckets[kind].get(fn[kind]) ?? new Map<string, CloneFunction>();
        bucket.set(fn.id, fn); this.buckets[kind].set(fn[kind], bucket);
      }
      for (const band of (fn as NearFunction)[nearFingerprint]?.bands ?? []) {
        const bucket = this.nearBands.get(band) ?? new Map<string, CloneFunction>();
        bucket.set(fn.id, fn); this.nearBands.set(band, bucket);
      }
    }
    this.generation++;
  }
  /** Precomputed bucket lookup for consumers; parsing never occurs in this method. */
  lookup(kind: CloneKind, fingerprint: string, options: CloneFilter = {}): readonly CloneFunction[] {
    return [...(this.buckets[kind].get(fingerprint)?.values() ?? [])]
      .filter(fn => options.includeClassified || (!fn.classification.vendored && !fn.classification.retired
        && (options.includeTests || !fn.classification.test))).sort(byLocation);
  }
  /** Precomputed LSH candidates, then ordered subtree rescoring. Exact/renamed
   * copies keep their existing lookup semantics and are not relabelled near.
   * Detached/deserialized records have no measured shape and return no matches.
   */
  near(target: CloneFunction, options: CloneFilter = {}): readonly CloneNearMatch[] {
    const fingerprint = (target as NearFunction)[nearFingerprint];
    if (!fingerprint || (this.files.has(target.path) && this.files.get(target.path)!.blobSha !== target.blobSha)) return [];
    const candidates = new Map<string, CloneFunction>();
    for (const band of fingerprint.bands)
      for (const [id, fn] of this.nearBands.get(band) ?? []) candidates.set(id, fn);
    const matches: CloneNearMatch[] = [];
    for (const fn of candidates.values()) {
      if (fn.id === target.id || fn.renamed === target.renamed) continue;
      if (!options.includeClassified && (fn.classification.vendored || fn.classification.retired
        || (!options.includeTests && fn.classification.test))) continue;
      if (Math.min(fn.mass, target.mass) / Math.max(fn.mass, target.mass) < CLONE_NEAR_POLICY.threshold) continue;
      const score = compareCloneNear(fingerprint, (fn as NearFunction)[nearFingerprint]!).similarity;
      if (score !== null && score >= CLONE_NEAR_POLICY.threshold) matches.push({ member: fn, score });
    }
    return matches.sort((a, b) => b.score - a.score || byLocation(a.member, b.member));
  }
  families(kind: CloneKind = 'renamed', options: CloneFilter & { crossFile?: boolean } = {}): CloneFamily[] {
    const families: CloneFamily[] = [];
    for (const fingerprint of this.buckets[kind].keys()) {
      const members = this.lookup(kind, fingerprint, options);
      const locations = new Set(members.map(fn => options.crossFile === false ? `${fn.path}:${fn.line}` : fn.path));
      if (locations.size < 2) continue;
      families.push({ id: `${CLONE_NORMALIZATION_VERSION}:floor-${this.minMass}:${kind}:${fingerprint}`,
        version: CLONE_NORMALIZATION_VERSION, fingerprint, kind, members });
    }
    return families.sort((a, b) => compare(a.id, b.id));
  }
}

export function buildCloneIndex(sources: Iterable<CloneSource>, options: { minMass?: number } = {}): CloneIndex {
  const index = new CloneIndex(options);
  for (const source of sources) index.update(source);
  return index;
}

/** Refresh from existing push hashes + carried working-set handles, outside the
 * synchronous hook. Explicit deleted paths distinguish deletion from a failed read.
 * Missing/stale inputs stay typed unavailable; they never retain obsolete members.
 */
export async function refreshCloneIndex(index: CloneIndex, input: {
  snapshot?: Pick<PushSnapshot, 'hashes'> | null;
  workingSet?: Pick<CodeWorkingSet, 'files'> | null;
  changedPaths?: readonly string[];
  deletedPaths?: readonly string[];
  readSource: (path: string) => Promise<string | null>;
}): Promise<{ updated: string[]; unchanged: string[]; unavailable: string[]; removed: string[] }> {
  const result = { updated: [] as string[], unchanged: [] as string[], unavailable: [] as string[], removed: [] as string[] };
  const deleted = new Set(input.deletedPaths ?? []), changed = new Set(input.changedPaths ?? []);
  const paths = new Set([...(input.snapshot?.hashes.keys() ?? []), ...(input.workingSet?.files.map(file => file.path) ?? []), ...changed]);
  for (const path of [...deleted].sort()) if (index.remove(path)) result.removed.push(path);
  for (const path of [...paths].sort()) {
    checkedPath(path);
    if (deleted.has(path)) continue;
    const previous = index.getFile(path);
    const expectedHash = input.snapshot?.hashes.get(path);
    if (!changed.has(path) && expectedHash && previous?.sha256 === expectedHash) { result.unchanged.push(path); continue; }
    let source: string | null;
    try { source = await input.readSource(path); }
    catch (error) {
      index.unavailable(path, `Source read failed: ${error instanceof Error ? error.message : String(error)}`);
      result.unavailable.push(path); continue;
    }
    if (source === null) { index.unavailable(path); result.unavailable.push(path); continue; }
    const update = index.update({ path, source });
    (update.changed ? result.updated : result.unchanged).push(path);
  }
  return result;
}
