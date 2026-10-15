/** EI-25266055698618523: committed version of the scoped caller parity probe.
 * Always measure BOTH references: a semantic NAME\s*( search can be empty while
 * the agent's literal NAME( search prints other identifiers (e.g. EventKey).
 * Reuses the production search roots/glob and the answer's declaration inventory.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as TsModule from 'typescript';
import { FIRST_PARTY_SOURCE_GLOB, resolveRipgrep, resolveSearchPaths, type FirstPartyCallersAnswer } from './first-party-callers';
import type { Ts } from './typescript-service';

export interface ReferenceHit { path: string; line1: number; col1: number; text: string }
const key = (s: { path: string; line1: number | null }): string => `${s.path}:${s.line1}`;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** No unparsed line is ever silently counted as zero, including single-file roots. */
export function parseReferenceOutput(raw: string): ReferenceHit[] {
  return raw.split('\n').filter(Boolean).map((line) => {
    const match = /^(?:\.\/)?(.*?):(\d+):(\d+):(.*)$/.exec(line);
    if (!match || !match[1] || Number(match[2]) < 1 || Number(match[3]) < 1) {
      throw new Error(`unparsed ripgrep reference line: ${line.slice(0, 160)}`);
    }
    return { path: match[1]!, line1: Number(match[2]), col1: Number(match[3]), text: match[4]! };
  });
}

/** Mandatory dual census over the identical non-empty, validated roots. */
export function callerReferences({ root, name, paths, rgPath }: {
  root: string; name: string; paths: readonly string[]; rgPath?: string;
}) {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error('caller name must be one identifier');
  if (paths.length === 0) throw new Error('explicit search roots required for re-measurement');
  const binary = rgPath ?? resolveRipgrep();
  if (binary === null) throw new Error('ripgrep reference binary unavailable');
  const scope = resolveSearchPaths(root, paths);
  if (!scope.ok) throw new Error(scope.error);
  const common = ['-n', '--column', '--with-filename', '--color=never', '-g', FIRST_PARTY_SOURCE_GLOB, '-g', '!**/node_modules/**'];
  const run = (args: string[]) => {
    try {
      return parseReferenceOutput(execFileSync(binary, args, { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }));
    } catch (error) {
      // Only ripgrep's verified no-match status means empty. Exit 2 (even with
      // partial stdout), spawn failures, timeouts and parse failures stay errors.
      if ((error as { status?: number }).status === 1) return [];
      throw error;
    }
  };
  const semantic = run([...common, '--pcre2', '--', `(?<![\\w$])${escapeRe(name)}\\s*\\(`, ...scope.paths]);
  const literal = run([...common, '-F', '--', `${name}(`, ...scope.paths]);
  const wordLiteral = new RegExp(`(?<![\\w$])${escapeRe(name)}\\(`);
  const substringOnly = literal.filter((hit) => !wordLiteral.test(hit.text));
  return { roots: scope.paths, semantic, literal, substringOnly };
}

function kindAt(ts: Ts, sf: TsModule.SourceFile, pos: number): string {
  let node: TsModule.Node = sf;
  for (;;) {
    const next = node.getChildren(sf).find((child) => child.pos <= pos && pos < child.end);
    if (!next) break;
    if (pos < next.getStart(sf)) return 'comment';
    if (ts.isJSDoc(next)) return 'jsdoc';
    node = next;
  }
  if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || node.kind === ts.SyntaxKind.JsxText) return 'string';
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
    const parent = node.parent;
    if (parent && (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent)
      || ts.isFunctionExpression(parent) || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent)
      || ts.isPropertyAssignment(parent) || ts.isVariableDeclaration(parent)) && parent.name === node) return 'declaration';
    if (parent && (ts.isTypeQueryNode(parent) || ts.isTypeReferenceNode(parent))) return 'type';
    let expression: TsModule.Node = node;
    while (expression.parent && ((ts.isPropertyAccessExpression(expression.parent) && expression.parent.name === expression)
      || ts.isParenthesizedExpression(expression.parent) || ts.isNonNullExpression(expression.parent))) expression = expression.parent;
    if (expression.parent && (ts.isCallExpression(expression.parent) || ts.isNewExpression(expression.parent))
      && expression.parent.expression === expression) return 'call?';
    return 'code-other';
  }
  return `unknown:${ts.SyntaxKind[node.kind]}`;
}

/** Compare a REAL handler answer with the mandatory dual reference. This is a
 * report, not an automatic equivalence verdict: errors/truncation are explicit.
 */
export function remeasureCallers({ ts, root, name, paths, answer, rgPath }: {
  ts: Ts; root: string; name: string; paths: readonly string[]; answer: FirstPartyCallersAnswer; rgPath?: string;
}) {
  const references = callerReferences({ root, name, paths, rgPath });
  const sites = new Set(answer.sites.map(key));
  const declarations = new Set((answer.attribution?.declarations ?? []).map(key));
  const semanticKeys = new Set(references.semantic.map(key));
  const omitted = [...new Map(references.semantic.filter((hit) => !sites.has(key(hit)) && !declarations.has(key(hit)))
    .map((hit) => [key(hit), hit])).values()];
  const sourceFiles = new Map<string, TsModule.SourceFile>();
  const byKind: Record<string, number> = {};
  const suspicious: string[] = [];
  const order = ['call?', 'code-other', 'declaration', 'type', 'string', 'comment', 'jsdoc', 'unknown'];
  for (const hit of omitted) {
    let sf = sourceFiles.get(hit.path);
    if (!sf) {
      sf = ts.createSourceFile(hit.path, readFileSync(join(root, hit.path), 'utf8'), ts.ScriptTarget.Latest, true);
      sourceFiles.set(hit.path, sf);
    }
    const text = sf.text.split('\n')[hit.line1 - 1];
    if (text === undefined || text.replace(/\r$/, '') !== hit.text) throw new Error(`source changed during reference measurement: ${key(hit)}`);
    const matches = [...text.matchAll(new RegExp(`(?<![\\w$])${escapeRe(name)}\\s*\\(`, 'g'))];
    const kinds = matches.map((match) => kindAt(ts, sf!, sf!.getPositionOfLineAndCharacter(hit.line1 - 1, match.index!)));
    const kind = kinds.sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] ?? 'nomatch';
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (!['comment', 'jsdoc', 'string', 'declaration'].includes(kind)) suspicious.push(`${key(hit)} [${kind}]`);
  }
  return {
    name, roots: references.roots, error: answer.error, truncated: answer.truncation.truncated,
    sites: answer.sites.length, noLine: answer.sites.filter((site) => site.line1 === null).length,
    grepLines: semanticKeys.size, grepNotSite: omitted.length, grepNotSiteByKind: byKind, suspicious,
    siteNotGrep: [...sites].filter((site) => !semanticKeys.has(site)),
    literal: { lines: new Set(references.literal.map(key)).size, substringOnly: new Set(references.substringOnly.map(key)).size,
      substringOnlySites: [...new Set(references.substringOnly.map(key))] },
    partialNameSearch: references.literal.length > 0 && references.semantic.length === 0 && declarations.size === 0,
  };
}
