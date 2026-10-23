/** P-015 / R-11. Metrics over the existing compiler AST; no second parser/index.
 * v1: body depth starts at 1. Every listed branch adds one cyclomatic point,
 * 1 + branch-ancestor count cognitive points, and one depth. Nested function
 * bodies belong only to that function. Length is physical body lines, minus
 * lines occupied exclusively by nested bodies. Offsets are half-open UTF-16.
 */
import { createHash } from 'node:crypto';
import type * as TS from 'typescript';
import type { Ts } from './typescript-service.ts';

export const CODE_HEALTH_VERSION = 'compiler/complexity-v1';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export interface Complexity { cyclomatic: number; cognitive: number }
export interface FunctionHealth extends Complexity {
  id: string; path: string; name: string; signature: string; contentHash: string;
  line1: number; start: number; end: number; length: number; nesting: number;
  /** Contributions permit split baselines to be partitioned without double counting. */
  branches: { start: number; end: number; cognitive: number }[];
}
export interface HealthSnapshot {
  metricVersion: string; compilerVersion: string; status: 'measured' | 'unknown';
  functions: FunctionHealth[]; limitations: string[];
}
type FunctionBody = TS.FunctionLikeDeclaration & { body: TS.ConciseBody };
const hasBody = (ts: Ts, node: TS.Node): node is FunctionBody =>
  ts.isFunctionLike(node) && 'body' in node && node.body !== undefined;

function branch(ts: Ts, node: TS.Node): boolean {
  return ts.isIfStatement(node) || ts.isForStatement(node) || ts.isForInStatement(node)
    || ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)
    || ts.isCatchClause(node) || ts.isCaseClause(node) || ts.isConditionalExpression(node)
    || ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind);
}

function functionName(ts: Ts, node: TS.Node, sf: TS.SourceFile): string {
  const names: string[] = [];
  for (let part: TS.Node | undefined = node; part && part !== sf; part = part.parent) {
    if (ts.isFunctionLike(part) || ts.isClassLike(part) || ts.isVariableDeclaration(part)
      || ts.isPropertyAssignment(part) || ts.isPropertyDeclaration(part)) {
      if ('name' in part && part.name) names.unshift((part.name as TS.Node).getText(sf));
      else if (part === node && !ts.isVariableDeclaration(part.parent)
        && !ts.isPropertyAssignment(part.parent) && !ts.isPropertyDeclaration(part.parent))
        names.unshift(`<anonymous@${part.getStart(sf)}>`);
    }
  }
  return names.join('.') || `<anonymous@${node.getStart(sf)}>`;
}

/** Accept SourceFiles directly from a compiler program; parse failures never mean zero. */
export function measureCodeHealth(ts: Ts, sf: TS.SourceFile, path = sf.fileName): HealthSnapshot {
  const base = { metricVersion: CODE_HEALTH_VERSION, compilerVersion: ts.version };
  const diagnostics = (sf as TS.SourceFile & { parseDiagnostics?: readonly TS.Diagnostic[] }).parseDiagnostics;
  if (diagnostics?.length) return { ...base, status: 'unknown', functions: [], limitations: ['Source has parse diagnostics.'] };
  const functions: FunctionHealth[] = [];
  const contentHash = hash(sf.text);
  const line = (at: number) => sf.getLineAndCharacterOfPosition(at).line;
  const visit = (node: TS.Node) => {
    if (hasBody(ts, node)) {
      const start = node.body.getStart(sf), end = node.body.end;
      const name = functionName(ts, node, sf);
      const signature = sf.text.slice(node.getStart(sf), start).replace(/\s+/g, ' ').trim();
      const branches: FunctionHealth['branches'] = [];
      let nesting = 1;
      const excludedLines = new Set<number>();
      const walk = (part: TS.Node, depth: number) => {
        if (part !== node.body && hasBody(ts, part)) {
          // Keep shared boundary lines (which also contain the outer declaration).
          for (let n = line(part.body.getStart(sf)) + 1; n < line(part.body.end - 1); n++) excludedLines.add(n);
          return;
        }
        const isBranch = branch(ts, part);
        if (isBranch) {
          branches.push({ start: part.getStart(sf), end: part.end, cognitive: 1 + depth });
          nesting = Math.max(nesting, depth + 2);
        }
        ts.forEachChild(part, child => walk(child, depth + Number(isBranch)));
      };
      walk(node.body, 0);
      functions.push({ id: `${path}:${name}:${hash(signature)}`, path, name, signature, contentHash,
        start, end, line1: line(node.getStart(sf)) + 1,
        length: line(end - 1) - line(start) + 1 - excludedLines.size, nesting,
        cyclomatic: 1 + branches.length, cognitive: branches.reduce((sum, b) => sum + b.cognitive, 0), branches });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { ...base, status: 'measured', functions, limitations: [] };
}

export interface PredecessorRange { id: string; start: number; end: number }
export interface HealthLineage {
  currentId: string;
  /** Explicit new declaration, recorded rename, or split with predecessor body ranges. */
  predecessors: PredecessorRange[];
}
export interface HealthDelta {
  id: string; status: 'measured' | 'unknown'; reason?: string;
  baseline: Complexity | null; current: Complexity; added: Complexity | null;
  warning: boolean;
}
export interface HealthRatchet {
  mode: 'warn-only'; status: 'measured' | 'partial' | 'unknown';
  deltas: HealthDelta[]; removed: string[]; warnings: string[];
  /** Persist this map with the snapshots when tracking a multi-change ratchet.
   * Increases never raise a watermark; reductions and removals shrink it. */
  nextWatermarks: Record<string, Complexity>;
}

/** Rename/split evidence must refer to exact prior snapshot offsets. An unpaired
 * deletion+addition may be a rename: it stays unknown without recorded lineage.
 * Each predecessor point (including its base cyclomatic point at body start) is
 * allocated at most once. Nested functions are never predecessor contributions.
 */
export function compareCodeHealth(before: HealthSnapshot, after: HealthSnapshot,
  lineage: readonly HealthLineage[] = [], watermarks: Readonly<Record<string, Complexity>> = {}): HealthRatchet {
  const valid = before.status === 'measured' && after.status === 'measured'
    && before.metricVersion === after.metricVersion && before.compilerVersion === after.compilerVersion;
  const old = new Map(before.functions.map(fn => [fn.id, fn]));
  const recorded = new Map(lineage.map(row => [row.currentId, row.predecessors]));
  const currentIds = new Set(after.functions.map(fn => fn.id));
  const unmatchedOld = before.functions.filter(fn => !currentIds.has(fn.id));
  const allocations = new Map<string, { id: string; start: number; end: number }[]>();
  const plans = after.functions.map(fn => {
    const prior = old.get(fn.id);
    const ranges = recorded.get(fn.id) ?? (prior ? [{ id: prior.id, start: prior.start, end: prior.end }]
      : unmatchedOld.length === 0 && !fn.name.includes('<anonymous@') ? [] : null);
    if (ranges) for (const range of ranges) {
      const list = allocations.get(range.id) ?? [];
      list.push({ ...range, id: fn.id }); allocations.set(range.id, list);
    }
    return { fn, ranges };
  });
  const invalid = new Set<string>();
  for (const [id, ranges] of allocations) {
    const prior = old.get(id);
    for (const range of ranges) if (!prior || !Number.isInteger(range.start) || !Number.isInteger(range.end)
      || range.start < prior.start || range.end > prior.end || range.start >= range.end)
      invalid.add(range.id);
    const ordered = [...ranges].sort((a, b) => a.start - b.start);
    for (let i = 0; i < ordered.length; i++) for (let j = i + 1; j < ordered.length; j++) {
      if (ordered[j]!.start >= ordered[i]!.end) break;
      invalid.add(ordered[i]!.id); invalid.add(ordered[j]!.id);
    }
  }
  // Uncertain identity/version must not erase history. Only confirmed consumption
  // or removal retires an old watermark below.
  const nextWatermarks: Record<string, Complexity> = Object.fromEntries(before.functions.map(fn =>
    [fn.id, watermarks[fn.id] ?? { cyclomatic: fn.cyclomatic, cognitive: fn.cognitive }]));
  const deltas: HealthDelta[] = plans.map(({ fn, ranges }) => {
    const current = { cyclomatic: fn.cyclomatic, cognitive: fn.cognitive };
    const unknown = !valid ? 'Metric/compiler version changed or source unmeasured.'
      : ranges === null ? 'Predecessor identity unknown; record rename/split/new lineage.'
      : recorded.has(fn.id) && lineage.filter(row => row.currentId === fn.id).length !== 1
        || invalid.has(fn.id) ? 'Invalid or overlapping predecessor ranges.' : null;
    if (unknown) return { id: fn.id, status: 'unknown', reason: unknown, baseline: null, current, added: null, warning: false };
    const baseline = { cyclomatic: 0, cognitive: 0 };
    for (const range of ranges!) {
      const prior = old.get(range.id)!;
      const whole = range.start === prior.start && range.end === prior.end;
      // Partition historical points by their starting offsets, never by overlap.
      const points = prior.branches.filter(b => b.start >= range.start && b.start < range.end);
      const measured = { cyclomatic: Number(range.start === prior.start) + points.length,
        cognitive: points.reduce((sum, b) => sum + b.cognitive, 0) };
      const watermark = watermarks[prior.id];
      // A reduced historical watermark cannot be allocated to split ranges without
      // point-level history. Refuse a fabricated partition rather than inflate it.
      if (!whole && watermark && (watermark.cyclomatic !== prior.cyclomatic || watermark.cognitive !== prior.cognitive))
        return { id: fn.id, status: 'unknown', reason: 'Split watermark needs point-level history.', baseline: null, current, added: null, warning: false };
      baseline.cyclomatic += whole && watermark ? Math.min(measured.cyclomatic, watermark.cyclomatic) : measured.cyclomatic;
      baseline.cognitive += whole && watermark ? Math.min(measured.cognitive, watermark.cognitive) : measured.cognitive;
    }
    const added = { cyclomatic: current.cyclomatic - baseline.cyclomatic, cognitive: current.cognitive - baseline.cognitive };
    nextWatermarks[fn.id] = { cyclomatic: Math.min(current.cyclomatic, baseline.cyclomatic), cognitive: Math.min(current.cognitive, baseline.cognitive) };
    return { id: fn.id, status: 'measured', baseline, current, added, warning: added.cyclomatic > 0 || added.cognitive > 0 };
  });
  const consumed = new Set([...allocations.keys(), ...currentIds]);
  const removed = valid ? before.functions.filter(fn => !consumed.has(fn.id)).map(fn => fn.id) : [];
  const unknown = deltas.some(delta => delta.status === 'unknown');
  if (valid) {
    for (const [id, ranges] of allocations) if (ranges.every(range => deltas.some(d => d.id === range.id && d.status === 'measured'))
      && !currentIds.has(id)) delete nextWatermarks[id];
    if (!unknown) for (const id of removed) delete nextWatermarks[id];
  }
  return { mode: 'warn-only', status: !valid ? 'unknown' : unknown ? 'partial' : 'measured', deltas, removed,
    warnings: deltas.filter(d => d.warning).map(d => `${d.id}: added cyclomatic ${d.added!.cyclomatic}, cognitive ${d.added!.cognitive} (advisory)`), nextWatermarks };
}
