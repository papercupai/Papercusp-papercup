/**
 * code-intel-delivery-and-outcomes-2026-10-26 P-007: the enclosing function/class
 * names of an edit, measured at edit time and stored on its
 * harness_shared.edit_attribution_ledger row (`symbols`). Recording them when the
 * edit happens keeps symbol history correct after the file is later rewritten.
 *
 * Function spans come from the existing compiler parse in measureCodeHealth
 * (`code-health.ts`), so a symbol name here is exactly the dotted name
 * readSymbolProvenance looks up. Class names are added from the same AST.
 *
 * Result contract: `null` = unknown (non-TS/JS path, unreadable file, git
 * unavailable, or parse diagnostics); `[]` = measured, the change touched no
 * named symbol (e.g. imports or top-level statements).
 *
 * HONEST LIMIT: the edit's hunk is not part of the native edit proof, so the
 * changed lines are derived by diffing the post-edit file against its committed
 * HEAD blob. Edits made since the last git-sync commit (by anyone) are therefore
 * included, which can over-attribute; they never under-attribute this edit.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Sql } from 'postgres';
import * as ts from 'typescript';
import type * as TS from 'typescript';
import { measureCodeHealth } from './code-health';

const run = promisify(execFile);
const SOURCE_PATH = /\.[cm]?[jt]sx?$/;
/** Above this many LCS cells the whole differing middle counts as changed. */
const MAX_LCS_CELLS = 1_000_000;

/** A changed region of the AFTER text, in 0-based lines. `end` is exclusive;
 * a pure deletion is a point (`start === end`) between lines start-1 and start. */
export interface ChangedLines { start: number; end: number }

export function changedLineRanges(before: string, after: string): ChangedLines[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix
    && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const mid = { a: a.slice(prefix, a.length - suffix), b: b.slice(prefix, b.length - suffix) };
  if (mid.a.length === 0 && mid.b.length === 0) return [];
  if (mid.a.length * mid.b.length > MAX_LCS_CELLS || mid.a.length === 0 || mid.b.length === 0) {
    return [{ start: prefix, end: prefix + mid.b.length }];
  }
  // LCS over the differing middle; unmatched AFTER lines are changed lines.
  const n = mid.a.length, m = mid.b.length, width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = mid.a[i] === mid.b[j]
        ? lcs[(i + 1) * width + j + 1]! + 1
        : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  const ranges: ChangedLines[] = [];
  let i = 0, j = 0, gapA = 0, gapStart = 0;
  const flush = () => {
    if (j > gapStart || gapA > 0) ranges.push({ start: prefix + gapStart, end: prefix + j });
    gapA = 0;
  };
  while (i < n || j < m) {
    if (i < n && j < m && mid.a[i] === mid.b[j]) { flush(); i++; j++; gapStart = j; continue; }
    if (j < m && (i >= n || lcs[i * width + j + 1]! >= lcs[(i + 1) * width + j]!)) j++;
    else { i++; gapA++; }
  }
  flush();
  return ranges;
}

/** A named function or class and its 0-based, inclusive declaration lines. */
export interface SymbolSpan { name: string; kind: 'function' | 'class'; first: number; last: number }

/** Every function/class span in `source`, named exactly as the ledger records them.
 * `null` = unknown (non-TS/JS path or parse diagnostics). Shared by the edit-time
 * writer and the prior-work readers (P-008), so all three use one vocabulary. */
export function symbolSpans(path: string, source: string): SymbolSpan[] | null {
  if (!SOURCE_PATH.test(path)) return null;
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true,
    /x$/.test(path) ? (path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.JSX)
      : /\.[cm]?js$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const health = measureCodeHealth(ts, sf, path);
  if (health.status !== 'measured') return null;
  const line = (at: number) => sf.getLineAndCharacterOfPosition(Math.max(0, at)).line;
  const spans: SymbolSpan[] = health.functions.map(fn => ({
    name: fn.name, kind: 'function' as const, first: fn.line1 - 1, last: line(fn.end - 1) }));
  const visit = (node: TS.Node) => {
    if (ts.isClassLike(node) && node.name) {
      spans.push({ name: node.name.getText(sf), kind: 'class', first: line(node.getStart(sf)), last: line(node.end - 1) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return spans;
}

/** Names of every function/class whose declaration lines contain a changed line. */
export function editedSymbols(path: string, before: string, after: string): string[] | null {
  const spans = symbolSpans(path, after);
  if (!spans) return null;
  const touched = new Set<string>();
  for (const range of changedLineRanges(before, after)) {
    for (const span of spans) {
      const hit = range.end > range.start
        ? span.first < range.end && span.last >= range.start
        // A deletion point counts only when the symbol encloses both neighbours.
        : span.first <= range.start - 1 && span.last >= range.start;
      if (hit) touched.add(span.name);
    }
  }
  return [...touched].sort();
}

export interface EditedSymbolDeps {
  readText?: (absPath: string) => Promise<string>;
  /** The committed blob, '' for a path absent from HEAD, null when git cannot answer. */
  headText?: (absPath: string) => Promise<string | null>;
}

async function gitHeadText(absPath: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-C', dirname(absPath), 'show', `HEAD:./${basename(absPath)}`],
      { maxBuffer: 32 * 1024 * 1024, timeout: 5_000, encoding: 'utf8' });
    return stdout;
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '');
    // A new (untracked or not-yet-committed) file: everything in it is the edit.
    return /does not exist in|exists on disk, but not in/.test(stderr) ? '' : null;
  }
}

export async function captureEditedSymbols(repoRoot: string, file: string,
  deps: EditedSymbolDeps = {}): Promise<string[] | null> {
  if (!SOURCE_PATH.test(file)) return null;
  try {
    const abs = resolve(repoRoot, file);
    const [after, before] = await Promise.all([
      (deps.readText ?? (p => readFile(p, 'utf8')))(abs),
      (deps.headText ?? gitHeadText)(abs),
    ]);
    return before === null ? null : editedSymbols(file, before, after);
  } catch {
    return null;
  }
}

/** Fill `symbols` on just-inserted ledger rows. First capture wins; never throws. */
export async function fillEditedSymbols(rows: readonly { id: string; file: string }[], repoRoot: string,
  sql: Sql, deps: EditedSymbolDeps = {}): Promise<number> {
  let filled = 0;
  for (const row of rows) {
    try {
      if (!/^[1-9][0-9]*$/.test(row.id)) continue;
      const symbols = await captureEditedSymbols(repoRoot, row.file, deps);
      if (symbols === null) continue;
      const updated = await sql<{ id: string }[]>`
        UPDATE harness_shared.edit_attribution_ledger
           SET symbols = ${symbols}::text[]
         WHERE id = ${row.id}::bigint AND repo_root = ${repoRoot} AND file = ${row.file}
           AND symbols IS NULL
         RETURNING id::text`;
      filled += updated.length;
    } catch {
      // best-effort: an unmeasured row stays NULL (unknown), never wrong.
    }
  }
  return filled;
}
