/** P-005: inspect current declarations without treating a cold graph as a deletion. */
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { withBoundedTimeout } from '../bounded-timeout';
import { safeSnapshotPath, type PushSnapshot, type SnapshotSymbol } from '../code-intelligence/push-snapshot';
import { declarationContentHash, type PlanItemAnchor } from './anchors';

export type AnchorFreshnessCheck =
  | { status: 'checked'; freshness: PlanItemAnchor['freshness'] }
  | { status: 'deferred'; reason: 'timeout' | 'unavailable' | 'ambiguous' | 'unsafe-path' }
  | { status: 'skipped' };

export interface AnchorFreshnessOptions {
  root: string;
  snapshot?: PushSnapshot | null;
  budgetMs?: number;
}

type SourceRead = { source: string } | { missing: true } | { deferred: 'unavailable' | 'unsafe-path' };

async function readSource(root: string, path: string, signal: AbortSignal): Promise<SourceRead> {
  if (!safeSnapshotPath(path)) return { deferred: 'unsafe-path' };
  let base: string;
  try { base = await realpath(root); } catch { return { deferred: 'unavailable' }; }
  try {
    const file = await realpath(join(base, path));
    const rel = relative(base, file);
    if (rel.startsWith('..') || isAbsolute(rel)) return { deferred: 'unsafe-path' };
    if ((await stat(file)).size > 2_000_000) return { deferred: 'unavailable' };
    return { source: await readFile(file, { encoding: 'utf8', signal }) };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { missing: true } : { deferred: 'unavailable' };
  }
}

/** Find the current token position; a stored line is informational, never identity. */
async function declarationSites(source: string, path: string, name: string): Promise<SnapshotSymbol[]> {
  const ts = await import('typescript');
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const sites: SnapshotSymbol[] = [];
  function visit(node: import('typescript').Node): void {
    if (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) || ts.isMethodDeclaration(node)
      || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      if (node.name?.getText(file) === name) {
        const at = file.getLineAndCharacterOfPosition(node.name.getStart(file));
        sites.push({ id: '', name, path, line: at.line + 1, column: at.character + 1,
          sha256: '', signature: '', aliases: [], callers: [] });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return sites;
}

/** Only a corroborated snapshot location can establish movement to another file. */
function movedCandidates(anchor: PlanItemAnchor, snapshot: PushSnapshot | null | undefined): SnapshotSymbol[] {
  const symbols = [...new Map([...(snapshot?.symbols?.values() ?? [])].flat()
    .map(symbol => [symbol.id, symbol])).values()];
  const identity = anchor.symbolId ? symbols.filter(symbol => symbol.id === anchor.symbolId) : [];
  return (identity.length ? identity : symbols.filter(symbol => symbol.name === (anchor.symbolName ?? anchor.requested)))
    .filter(symbol => symbol.path !== anchor.path);
}

export async function checkPlanItemAnchorFreshness(
  anchor: PlanItemAnchor, options: AnchorFreshnessOptions,
): Promise<AnchorFreshnessCheck> {
  if (anchor.anchorKind === 'path') return { status: 'skipped' };
  if (!anchor.path || !anchor.contentHash) return { status: 'deferred', reason: 'unavailable' };
  const result = await withBoundedTimeout<AnchorFreshnessCheck>(async signal => {
    const original = await readSource(options.root, anchor.path!, signal);
    if ('deferred' in original) return { status: 'deferred', reason: original.deferred };
    if ('source' in original) {
      const sites = await declarationSites(original.source, anchor.path!, anchor.symbolName ?? anchor.requested);
      if (sites.length > 1) return { status: 'deferred', reason: 'ambiguous' };
      if (sites[0]) {
        const currentHash = await declarationContentHash(original.source, sites[0]);
        if (!currentHash) return { status: 'deferred', reason: 'unavailable' };
        return { status: 'checked', freshness: currentHash === anchor.contentHash ? 'fresh' : 'stale' };
      }
    }
    const candidates = movedCandidates(anchor, options.snapshot);
    if (candidates.length > 1) return { status: 'deferred', reason: 'ambiguous' };
    if (candidates[0]) {
      const candidate = candidates[0];
      const moved = await readSource(options.root, candidate.path, signal);
      if ('deferred' in moved) return { status: 'deferred', reason: moved.deferred };
      if ('source' in moved) {
        // An old graph row is not evidence of a live destination.
        const digest = createHash('sha256').update(moved.source).digest('hex');
        if (digest !== candidate.sha256) return { status: 'deferred', reason: 'unavailable' };
        if (await declarationContentHash(moved.source, candidate)) return { status: 'checked', freshness: 'stale' };
      }
    }
    // The actual original source no longer declares the symbol (or its file is gone).
    // This conclusion does not depend on the graph being warm or current.
    return { status: 'checked', freshness: 'missing' };
  }, { timeoutMs: options.budgetMs ?? 250, label: 'plan-anchor-freshness', warn: false,
    fallback: { status: 'deferred', reason: 'timeout' } });
  if (result.reason === 'error') throw result.error;
  return result.value;
}
