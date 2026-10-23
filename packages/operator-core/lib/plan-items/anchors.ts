/** Code links are canonical metadata; rendered Markdown is only a view (D-014). */
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import { withBoundedTimeout } from '../bounded-timeout';
import {
  corroboratePushSources, peekPushSnapshot, safeSnapshotPath,
  type PushSnapshot, type SnapshotSymbol, type PushProofSource,
} from '../code-intelligence/push-snapshot';

export const anchorInputSchema = z.union([
  z.object({ symbol: z.string().trim().min(1).max(300) }).strict(),
  z.object({ path: z.string().trim().min(1).max(4096) }).strict(),
]);
export const anchorsInputSchema = z.array(anchorInputSchema).max(32);
export type AnchorInput = z.infer<typeof anchorInputSchema>;
export type AnchorUnknownReason = 'timeout' | 'not-found' | 'ambiguous' | 'no-snapshot';
export interface PlanItemAnchor {
  id?: string;
  anchorKind: 'symbol' | 'path';
  requested: string;
  symbolId: string | null;
  symbolName: string | null;
  path: string | null;
  line: number | null;
  signature: string | null;
  contentHash: string | null;
  consumers: { path: string; line: number }[];
  /** Observed snapshot callers, a lower bound rather than a repository census. */
  consumersTotal: number;
  tests: string[];
  resolution: 'resolved' | 'unknown';
  unknownReason: AnchorUnknownReason | null;
  freshness: 'fresh' | 'stale' | 'missing';
  resolvedCommit: string | null;
  staleNoticeId?: string | null;
}
export const ANCHOR_RESOLUTION_BUDGET_MS = 250;
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

export function unknownAnchor(input: AnchorInput, reason: AnchorUnknownReason): PlanItemAnchor {
  return {
    anchorKind: 'symbol' in input ? 'symbol' : 'path',
    requested: 'symbol' in input ? input.symbol : input.path,
    symbolId: null, symbolName: 'symbol' in input ? input.symbol : null,
    path: 'path' in input ? input.path : null, line: null, signature: null, contentHash: null,
    consumers: [], consumersTotal: 0, tests: [], resolution: 'unknown', unknownReason: reason,
    freshness: 'missing', resolvedCommit: null,
  };
}

/** Hash the declaration, not its whole file; unrelated edits do not stale a symbol. */
export async function declarationContentHash(source: string, symbol: SnapshotSymbol): Promise<string | null> {
  const ts = await import('typescript');
  const file = ts.createSourceFile(symbol.path, source, ts.ScriptTarget.Latest, true);
  let declaration: string | null = null;
  function normalize(node: import('typescript').Node): string {
    const chunks: string[] = [];
    let offset = node.getStart(file);
    function preserveLiterals(child: import('typescript').Node): void {
      if (ts.isStringLiteralLike(child) || ts.isTemplateLiteralToken(child)
        || child.kind === ts.SyntaxKind.RegularExpressionLiteral || child.kind === ts.SyntaxKind.JsxText) {
        const start = child.getStart(file);
        chunks.push(source.slice(offset, start).replace(/\s+/g, ' '), source.slice(start, child.end));
        offset = child.end;
        return;
      }
      ts.forEachChild(child, preserveLiterals);
    }
    // Whitespace in literal tokens is a value, not formatting. Let the parser
    // identify template/regex boundaries rather than trying to quote-match text.
    preserveLiterals(node);
    chunks.push(source.slice(offset, node.end).replace(/\s+/g, ' '));
    return chunks.join('').trim();
  }
  function visit(node: import('typescript').Node): void {
    if (declaration !== null) return;
    if (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) || ts.isMethodDeclaration(node)
      || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      const name = node.name;
      if (name && name.getText(file) === symbol.name) {
        const at = file.getLineAndCharacterOfPosition(name.getStart(file));
        if (at.line + 1 === symbol.line && at.character + 1 === symbol.column) declaration = normalize(node);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return declaration === null ? null : hash(declaration);
}

async function readAnchorSource(root: string, path: string, signal: AbortSignal): Promise<Buffer | null> {
  if (!safeSnapshotPath(path)) return null;
  try {
    const [base, file] = await Promise.all([realpath(root), realpath(join(root, path))]);
    const rel = relative(base, file);
    if (rel.startsWith('..') || isAbsolute(rel) || (await stat(file)).size > 2_000_000) return null;
    return await readFile(file, { signal });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

const testPath = (path: string) => /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)__tests__\/)/.test(path);
function reachingTests(snapshot: PushSnapshot, path: string, symbol: SnapshotSymbol): { tests: string[]; proofs: PushProofSource[] } {
  const found = new Set(symbol.callers.filter(c => testPath(c.path)).map(c => c.path));
  const parents = new Map<string, string | null>([[path, null]]);
  const seen = new Set<string>();
  const queue = [path];
  while (queue.length && seen.size < 128 && found.size < 50) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    for (const importer of snapshot.importers.get(next) ?? []) {
      const sha256 = snapshot.hashes.get(importer);
      if (!sha256) continue; // An uncorroboratable edge establishes no positive test reachability.
      if (testPath(importer)) found.add(importer);
      if (!parents.has(importer)) {
        parents.set(importer, next);
        queue.push(importer);
      }
    }
  }
  const tests = [...found].sort().slice(0, 50);
  const proofs = new Map<string, PushProofSource>();
  // Reachability is positive evidence: one corroborated path per returned test
  // proves it. Unselected import branches establish no returned fact and must
  // not consume the source budget or invalidate an otherwise sound anchor.
  for (const test of tests) {
    let current: string | null | undefined = test;
    while (current && current !== path) {
      const sha256 = snapshot.hashes.get(current);
      if (sha256) proofs.set(current, { path: current, sha256 });
      current = parents.get(current);
    }
  }
  return { tests, proofs: [...proofs.values()] };
}

export interface AnchorResolveOptions {
  root: string;
  snapshot?: PushSnapshot | null | (() => Promise<PushSnapshot | null>);
  budgetMs?: number;
}

/** One shared wall budget, with cancellation, even when a dependency never settles. */
export async function resolvePlanItemAnchors(inputs: AnchorInput[], options: AnchorResolveOptions): Promise<PlanItemAnchor[]> {
  anchorsInputSchema.parse(inputs);
  const result = await withBoundedTimeout(async signal => {
    const snapshot = typeof options.snapshot === 'function' ? await options.snapshot()
      : options.snapshot ?? null;
    return Promise.all(inputs.map(async input => {
      const empty = unknownAnchor(input, 'not-found');
      if ('path' in input) {
        const bytes = await readAnchorSource(options.root, input.path, signal);
        return bytes ? { ...empty, contentHash: hash(bytes), resolution: 'resolved' as const,
          unknownReason: null, freshness: 'fresh' as const } : empty;
      }
      if (!snapshot) return unknownAnchor(input, 'no-snapshot');
      const candidates = [...new Map((snapshot.symbols?.get(input.symbol) ?? []).map(s => [s.id, s])).values()];
      if (candidates.length !== 1) return unknownAnchor(input, candidates.length ? 'ambiguous' : 'not-found');
      const symbol = candidates[0]!;
      const bytes = await readAnchorSource(options.root, symbol.path, signal);
      const topology = reachingTests(snapshot, symbol.path, symbol);
      const proofs = [...new Map([...(symbol.sources ?? []), { path: symbol.path, sha256: symbol.sha256 },
        ...symbol.callers.map(c => ({ path: c.path, sha256: c.sha256 })), ...topology.proofs]
        .map(proof => [JSON.stringify(proof), proof])).values()];
      if (!bytes || hash(bytes) !== symbol.sha256 || !await corroboratePushSources(options.root,
        proofs, signal, 512)) {
        return unknownAnchor(input, 'no-snapshot');
      }
      const contentHash = await declarationContentHash(bytes.toString('utf8'), symbol);
      if (!contentHash) return empty;
      return { ...empty, symbolId: symbol.id, symbolName: symbol.name, path: symbol.path,
        line: symbol.line, signature: symbol.signature, contentHash,
        consumers: symbol.callers.slice(0, 50).map(c => ({ path: c.path, line: c.line })),
        consumersTotal: symbol.callers.length, tests: topology.tests,
        resolution: 'resolved' as const, unknownReason: null, freshness: 'fresh' as const,
        resolvedCommit: snapshot.commit };
    }));
  }, { fallback: inputs.map(input => unknownAnchor(input, 'timeout')),
    timeoutMs: options.budgetMs ?? ANCHOR_RESOLUTION_BUDGET_MS, label: 'plan-item-anchors', warn: false });
  if (result.reason === 'error') throw result.error;
  return result.value;
}

export async function resolveHarnessAnchors(workspaceId: string, harnessSlug: string, inputs: AnchorInput[]): Promise<PlanItemAnchor[]> {
  if (!inputs.length) return [];
  const result = await withBoundedTimeout(async () => {
    const { loadHarnessRegistry } = await import('../harness-registry');
    const root = (await loadHarnessRegistry(workspaceId)).projects.find(p => p.slug === harnessSlug)?.path;
    if (!root) return inputs.map(input => unknownAnchor(input, 'not-found'));
    return resolvePlanItemAnchors(inputs, { root, snapshot: peekPushSnapshot(harnessSlug) });
  }, { fallback: inputs.map(input => unknownAnchor(input, 'timeout')),
    timeoutMs: ANCHOR_RESOLUTION_BUDGET_MS, label: 'plan-anchor-root', warn: false });
  if (result.reason === 'error') throw result.error;
  return result.value;
}

export function renderAnchorLine(anchor: PlanItemAnchor): string {
  const label = anchor.symbolName ?? anchor.requested;
  return `  ↳ code: ${JSON.stringify(label)} ${anchor.path ?? ''} · ${anchor.resolution === 'unknown'
    ? `unknown (${anchor.unknownReason})` : `${anchor.freshness} · ${anchor.consumers.length} observed callers · ${anchor.tests.length} reaching tests`}`;
}

export function stripRenderedAnchorLines(body: string): string {
  let fence: string | null = null;
  return body.split('\n').filter(line => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return true;
    }
    return fence !== null || !/^\s*↳ code:/.test(line);
  }).join('\n');
}
