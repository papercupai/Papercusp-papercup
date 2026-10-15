/**
 * P-017 pooled-adjudication assistant (plan `gitnexus-deterministic-integration-2026-10-05`,
 * D-011/D-012/D-013). The scorer pools every site any arm returned that the answer key has
 * not ruled on (`poolCandidates`); a real run leaves thousands. This module PROPOSES a verdict
 * for each pooled site by applying the D-012 answer unit for the case's intent against the
 * frozen snapshot, using the TypeScript checker to resolve each identifier and call expression.
 *
 * Independence: it never asks call hierarchy (the no-third-party arm's own mechanism) for an
 * answer. It reads the site's line, resolves the symbols written there, and applies the unit
 * rule. A site it cannot rule on (impact, symbol-search, interface-member callees, a call line
 * naming several callees, no resolvable subject) comes back undecided and stays for hand review.
 * Calibrated against the human-verified micro-repo keys (fair-comparison-adjudicate.test.ts).
 *
 * Every verdict carries a note naming the rule and the line it read, so a reviewer can audit
 * any ruling without re-deriving it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type * as TsModule from 'typescript';
import { applyAdjudication, type AdjudicationVerdict, type AnswerKey, type FairCase, type FairIntent, type SiteKey } from './fair-comparison';
import type { TsTree } from './fair-comparison-first-party';

type Node = TsModule.Node;
type Sym = TsModule.Symbol;

/** Intents this assistant rules on. impact and symbol-search stay with hand review. */
export const AUTO_ADJUDICATED_INTENTS: readonly FairIntent[] = ['callers', 'callees', 'references', 'definition', 'text-search'];

export interface SiteRuling {
  readonly site: SiteKey;
  /** The proposed verdicts: the site's own, plus a `valid` for an alias target the key lacks. */
  readonly verdicts: readonly AdjudicationVerdict[];
  /** Set when `verdicts` is empty: why the site was left for hand review. */
  readonly undecided?: string;
}

export interface Adjudicator {
  adjudicate(kase: FairCase, sites: readonly SiteKey[], key: AnswerKey): SiteRuling[];
}

const posix = (p: string): string => p.split(sep).join('/');
const excerpt = (s: string): string => {
  const t = s.trim();
  return t.length > 140 ? `${t.slice(0, 137)}...` : t;
};

export function parseSiteKey(site: SiteKey): { path: string; line1: number } | null {
  const i = site.lastIndexOf(':');
  if (i <= 0) return null;
  const line1 = Number(site.slice(i + 1));
  return Number.isInteger(line1) && line1 >= 1 ? { path: site.slice(0, i), line1 } : null;
}

/** The declaration file TypeScript resolves an import of a JS file to, and back. */
export function declarationSiblings(path: string): string[] {
  const swaps: Array<[RegExp, string]> = [
    [/\.d\.mts$/, '.mjs'],
    [/\.d\.cts$/, '.cjs'],
    [/\.d\.ts$/, '.js'],
    [/\.mjs$/, '.d.mts'],
    [/\.cjs$/, '.d.cts'],
    [/\.js$/, '.d.ts'],
  ];
  for (const [re, ext] of swaps) if (re.test(path)) return [path.replace(re, ext)];
  return [];
}

interface Scope {
  readonly node: Node;
  readonly label: string;
  /** The scope's declaration lines: its statement start and its name. */
  readonly declLines: ReadonlySet<number>;
}

interface Subject {
  readonly symbols: ReadonlySet<Sym>;
  readonly decls: readonly Node[];
  /** `path:line` of each subject declaration name. */
  readonly declSites: ReadonlySet<SiteKey>;
}

interface CalleeIndex {
  readonly canonical: ReadonlyMap<SiteKey, string>;
  readonly aliases: ReadonlyMap<SiteKey, SiteKey>;
  readonly ambiguous: ReadonlySet<SiteKey>;
  /** Call lines in the subject body -> the canonical sites of the first-party callees called there. */
  readonly callLines: ReadonlyMap<SiteKey, ReadonlySet<SiteKey>>;
  /** Call lines in the subject body whose callee is a built-in or third-party declaration: neutral (D-012). */
  readonly externalLines: ReadonlySet<SiteKey>;
  readonly hasBody: boolean;
}

export function createAdjudicator(tree: TsTree): Adjudicator {
  const ts = tree.ts;
  const program = tree.service.getProgram();
  if (!program) throw new Error('adjudicator: the language service produced no program');
  const checker = program.getTypeChecker();
  const rel = (fileName: string): string => posix(relative(tree.root, fileName));
  const inTree = (fileName: string): boolean => {
    const r = rel(fileName);
    return !r.startsWith('../') && !isAbsolute(r) && !r.split('/').includes('node_modules');
  };
  const sourceFile = (path: string): TsModule.SourceFile | undefined => program.getSourceFile(join(tree.root, path));
  const lineOf = (sf: TsModule.SourceFile, pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const siteAt = (sf: TsModule.SourceFile, pos: number): SiteKey => `${rel(sf.fileName)}:${lineOf(sf, pos)}`;
  const lineText = (sf: TsModule.SourceFile, line1: number): string => {
    const starts = sf.getLineStarts();
    const end = line1 < starts.length ? starts[line1]! : sf.text.length;
    return sf.text.slice(starts[line1 - 1]!, end).replace(/\r?\n$/, '');
  };
  const firstCodePos = (sf: TsModule.SourceFile, line1: number): number => {
    let p = sf.getLineStarts()[line1 - 1]!;
    while (p < sf.text.length && (sf.text[p] === ' ' || sf.text[p] === '\t')) p++;
    return p;
  };

  const resolve = (sym: Sym | undefined): Sym | undefined => {
    let s = sym;
    for (let i = 0; s && i < 4 && s.flags & ts.SymbolFlags.Alias; i++) {
      try {
        s = checker.getAliasedSymbol(s);
      } catch {
        break;
      }
    }
    return s;
  };
  const symbolAt = (n: Node): Sym | undefined => {
    try {
      return resolve(checker.getSymbolAtLocation(n));
    } catch {
      return undefined;
    }
  };

  // ─── subject ──────────────────────────────────────────────────────────────
  const subjects = new Map<string, Subject>();
  function findDeclName(sf: TsModule.SourceFile, start: number, end: number, name: string): TsModule.Identifier | undefined {
    let found: TsModule.Identifier | undefined;
    const visit = (n: Node): void => {
      if (found || n.end < start || n.getStart(sf) > end) return;
      const nm = (n as { name?: Node }).name;
      if (nm && ts.isIdentifier(nm) && nm.text === name) {
        const at = nm.getStart(sf);
        if (at >= start && at < end) {
          found = nm;
          return;
        }
      }
      n.forEachChild(visit);
    };
    visit(sf);
    return found;
  }
  function subjectOf(kase: FairCase): Subject {
    const cacheKey = `${kase.subject}|${kase.anchorFile ?? ''}`;
    const hit = subjects.get(cacheKey);
    if (hit) return hit;
    let items = tree.service.getNavigateToItems(kase.subject, undefined, undefined, false, true).filter((i) => i.name === kase.subject && inTree(i.fileName));
    if (kase.anchorFile) {
      const allowed = new Set([kase.anchorFile, ...declarationSiblings(kase.anchorFile)]);
      const narrowed = items.filter((i) => allowed.has(rel(i.fileName)));
      if (narrowed.length > 0) items = narrowed;
    }
    const symbols = new Set<Sym>();
    const decls: Node[] = [];
    const declSites = new Set<SiteKey>();
    for (const item of items) {
      const sf = program!.getSourceFile(item.fileName);
      if (!sf) continue;
      const ident = findDeclName(sf, item.textSpan.start, item.textSpan.start + item.textSpan.length, kase.subject);
      if (!ident) continue;
      const raw = checker.getSymbolAtLocation(ident);
      if (raw) symbols.add(raw);
      const sym = resolve(raw);
      if (sym) symbols.add(sym);
      decls.push(ident.parent);
      declSites.add(siteAt(sf, ident.getStart(sf)));
    }
    const subject = { symbols, decls, declSites };
    subjects.set(cacheKey, subject);
    return subject;
  }

  // ─── scopes and calls ─────────────────────────────────────────────────────
  const isNamedFunctionLike = (n: Node): boolean =>
    ts.isFunctionDeclaration(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n) ||
    ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
      (ts.isVariableDeclaration(n.parent) || ts.isPropertyAssignment(n.parent) || ts.isPropertyDeclaration(n.parent)));
  const scopeIndex = new Map<string, Map<Node, Scope>>();
  function scopesOf(sf: TsModule.SourceFile): Map<Node, Scope> {
    const hit = scopeIndex.get(sf.fileName);
    if (hit) return hit;
    const out = new Map<Node, Scope>();
    const visit = (n: Node): void => {
      if (isNamedFunctionLike(n)) {
        const holder = ts.isArrowFunction(n) || ts.isFunctionExpression(n) ? n.parent : n;
        const nm = (holder as { name?: Node }).name;
        const stmt = ts.isVariableDeclaration(holder) && ts.isVariableStatement(holder.parent.parent) ? holder.parent.parent : holder;
        const lines = new Set<number>([lineOf(sf, stmt.getStart(sf))]);
        if (nm) lines.add(lineOf(sf, nm.getStart(sf)));
        out.set(n, { node: n, label: nm ? nm.getText(sf) : ts.SyntaxKind[n.kind], declLines: lines });
      }
      n.forEachChild(visit);
    };
    visit(sf);
    scopeIndex.set(sf.fileName, out);
    return out;
  }
  /** The calling scope a line belongs to: a scope whose declaration line it is, else the innermost containing scope; null = module top level. */
  function scopeForLine(sf: TsModule.SourceFile, line1: number): Scope | null {
    const scopes = [...scopesOf(sf).values()];
    const span = (s: Scope): number => s.node.end - s.node.getStart(sf);
    const byDecl = scopes.filter((s) => s.declLines.has(line1)).sort((a, b) => span(a) - span(b));
    if (byDecl.length > 0) return byDecl[0]!;
    const pos = firstCodePos(sf, line1);
    const containing = scopes.filter((s) => s.node.getStart(sf) <= pos && pos < s.node.end).sort((a, b) => span(a) - span(b));
    return containing[0] ?? null;
  }
  /** The symbol a call expression invokes, and the node naming it (for the call's line). */
  function callee(expr: TsModule.Expression): { sym: Sym | undefined; name: Node } | null {
    let e: TsModule.Expression = expr;
    while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) e = e.expression;
    if (ts.isIdentifier(e)) return { sym: symbolAt(e), name: e };
    if (ts.isPropertyAccessExpression(e)) {
      if (['call', 'apply', 'bind'].includes(e.name.text)) {
        const inner = callee(e.expression);
        if (inner?.sym) return inner;
      }
      return { sym: symbolAt(e.name), name: e.name };
    }
    if (ts.isElementAccessExpression(e)) return { sym: symbolAt(e.argumentExpression), name: e.argumentExpression };
    return null;
  }
  const callCache = new Map<string, Array<{ line1: number; scope: Scope | null }>>();
  function callsTo(sf: TsModule.SourceFile, subject: Subject, subjectKey: string): Array<{ line1: number; scope: Scope | null }> {
    const cacheKey = `${sf.fileName}|${subjectKey}`;
    const hit = callCache.get(cacheKey);
    if (hit) return hit;
    const scopes = scopesOf(sf);
    const out: Array<{ line1: number; scope: Scope | null }> = [];
    const visit = (n: Node, scope: Scope | null): void => {
      const here = scopes.get(n) ?? scope;
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const c = callee(n.expression);
        if (c?.sym && subject.symbols.has(c.sym)) out.push({ line1: lineOf(sf, c.name.getStart(sf)), scope: here });
        // Dynamic dispatch: the subject handed to a call as a callback (`rows.sort(byLabel)`) is a call site.
        for (const arg of n.arguments ?? []) {
          const nm = ts.isIdentifier(arg) ? arg : ts.isPropertyAccessExpression(arg) ? arg.name : null;
          if (nm && subject.symbols.has(symbolAt(nm)!)) out.push({ line1: lineOf(sf, nm.getStart(sf)), scope: here });
        }
      }
      n.forEachChild((child) => visit(child, here));
    };
    visit(sf, null);
    callCache.set(cacheKey, out);
    return out;
  }
  /** Every line in a file whose identifier resolves to the subject (its own declaration excluded), with its scope. */
  const refCache = new Map<string, Array<{ line1: number; scope: Scope | null }>>();
  function referencesIn(sf: TsModule.SourceFile, subject: Subject, subjectKey: string): Array<{ line1: number; scope: Scope | null }> {
    const cacheKey = `${sf.fileName}|${subjectKey}`;
    const hit = refCache.get(cacheKey);
    if (hit) return hit;
    const scopes = scopesOf(sf);
    const out: Array<{ line1: number; scope: Scope | null }> = [];
    const name = [...subject.decls].map((d) => (d as { name?: Node }).name?.getText(d.getSourceFile()))[0];
    const visit = (n: Node, scope: Scope | null): void => {
      const here = scopes.get(n) ?? scope;
      if (ts.isIdentifier(n) && n.text === name) {
        const site = siteAt(sf, n.getStart(sf));
        if (!subject.declSites.has(site) && subject.symbols.has(symbolAt(n)!)) out.push({ line1: lineOf(sf, n.getStart(sf)), scope: here });
      }
      n.forEachChild((child) => visit(child, here));
    };
    visit(sf, null);
    refCache.set(cacheKey, out);
    return out;
  }

  // ─── callees ──────────────────────────────────────────────────────────────
  const calleeCache = new Map<string, CalleeIndex>();
  const bodyOf = (decl: Node): Node | null => {
    if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl) || ts.isConstructorDeclaration(decl) || ts.isGetAccessorDeclaration(decl) || ts.isSetAccessorDeclaration(decl)) {
      return decl.body ?? null;
    }
    if ((ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl) || ts.isPropertyDeclaration(decl)) && decl.initializer) {
      const init = decl.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init.body;
    }
    return null;
  };
  const hasImplementation = (d: Node): boolean =>
    !d.getSourceFile().isDeclarationFile && (bodyOf(d) !== null || ts.isVariableDeclaration(d) || ts.isClassDeclaration(d) || ts.isPropertyDeclaration(d));
  /** A top-level declaration named `name` in the JS file a declaration file describes. */
  function jsImplementation(d: Node, name: string): Node | undefined {
    const sf = d.getSourceFile();
    if (!sf.isDeclarationFile) return undefined;
    for (const sib of declarationSiblings(rel(sf.fileName))) {
      const js = sourceFile(sib);
      if (!js) continue;
      for (const st of js.statements) {
        if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name?.text === name) return st;
        if (ts.isVariableStatement(st)) {
          for (const v of st.declarationList.declarations) if (ts.isIdentifier(v.name) && v.name.text === name) return v;
        }
      }
    }
    return undefined;
  }
  const nameSite = (d: Node): SiteKey => {
    const sf = d.getSourceFile();
    const nm = (d as { name?: Node }).name;
    return siteAt(sf, (nm ?? d).getStart(sf));
  };
  function calleesOf(kase: FairCase, subject: Subject): CalleeIndex {
    const cacheKey = `${kase.subject}|${kase.anchorFile ?? ''}`;
    const hit = calleeCache.get(cacheKey);
    if (hit) return hit;
    const canonical = new Map<SiteKey, string>();
    const aliases = new Map<SiteKey, SiteKey>();
    const ambiguous = new Set<SiteKey>();
    const callLines = new Map<SiteKey, Set<SiteKey>>();
    const externalLines = new Set<SiteKey>();
    let hasBody = false;
    for (const decl of subject.decls) {
      const body = bodyOf(decl);
      if (!body) continue;
      hasBody = true;
      const sf = decl.getSourceFile();
      const visit = (n: Node): void => {
        if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
          const c = callee(n.expression);
          const decls = c?.sym?.declarations ?? [];
          const firstParty = decls.filter((d) => inTree(d.getSourceFile().fileName) && !ts.isParameter(d) && !ts.isBindingElement(d));
          if (c && decls.length > 0 && decls.every((d) => !inTree(d.getSourceFile().fileName))) externalLines.add(siteAt(sf, c.name.getStart(sf)));
          if (c && firstParty.length > 0) {
            if (firstParty.every((d) => ts.isPropertySignature(d) || ts.isMethodSignature(d))) {
              for (const d of firstParty) ambiguous.add(nameSite(d));
            } else {
              const impl = firstParty.find(hasImplementation) ?? firstParty[0]!;
              const js = jsImplementation(impl, c.name.getText(sf));
              const canon = nameSite(js ?? impl);
              canonical.set(canon, c.name.getText(sf));
              for (const d of [...firstParty, ...(js ? [impl] : [])]) {
                const s = nameSite(d);
                if (s !== canon) aliases.set(s, canon);
                const stmtLine = siteAt(d.getSourceFile(), d.getStart(d.getSourceFile()));
                if (stmtLine !== canon && !canonical.has(stmtLine)) aliases.set(stmtLine, canon);
              }
              const callSite = siteAt(sf, c.name.getStart(sf));
              if (!callLines.has(callSite)) callLines.set(callSite, new Set());
              callLines.get(callSite)!.add(canon);
            }
          }
        }
        n.forEachChild(visit);
      };
      visit(body);
    }
    const idx = { canonical, aliases, ambiguous, callLines, externalLines, hasBody };
    calleeCache.set(cacheKey, idx);
    return idx;
  }

  // ─── rulings ──────────────────────────────────────────────────────────────
  return {
    adjudicate(kase: FairCase, sites: readonly SiteKey[], key: AnswerKey): SiteRuling[] {
      const keyValid = new Set(key.sites);
      const out: SiteRuling[] = [];
      const auto = (rule: string, text: string): string => `auto(D-012 ${kase.intent}): ${rule}; line: ${excerpt(text)}`;
      for (const site of sites) {
        const undecided = (why: string): SiteRuling => ({ site, verdicts: [], undecided: why });
        const verdict = (v: AdjudicationVerdict['verdict'], note: string, aliasOf?: SiteKey): SiteRuling => {
          if (v !== 'alias' || !aliasOf) return { site, verdicts: [{ site, verdict: v, note }] };
          const target: AdjudicationVerdict[] = keyValid.has(aliasOf) ? [] : [{ site: aliasOf, verdict: 'valid', note: `auto(D-012 ${kase.intent}): canonical unit site for ${site}` }];
          keyValid.add(aliasOf);
          return { site, verdicts: [...target, { site, verdict: 'alias', aliasOf, note }] };
        };
        if (!AUTO_ADJUDICATED_INTENTS.includes(kase.intent)) {
          out.push(undecided(`intent ${kase.intent} is hand-adjudicated`));
          continue;
        }
        const parsed = parseSiteKey(site);
        if (!parsed) {
          out.push(verdict('invalid', `auto(D-012 ${kase.intent}): malformed site key`));
          continue;
        }
        const abs = join(tree.root, parsed.path);
        if (!existsSync(abs)) {
          out.push(verdict('invalid', `auto(D-012 ${kase.intent}): no such file in the frozen tree`));
          continue;
        }
        if (kase.intent === 'text-search') {
          const line = readFileSync(abs, 'utf8').split('\n')[parsed.line1 - 1];
          if (line === undefined) out.push(verdict('invalid', auto('line is past the end of the file', '')));
          else if (line.includes(kase.subject)) out.push(verdict('valid', auto('line contains the literal', line)));
          else out.push(verdict('invalid', auto('line does not contain the literal', line)));
          continue;
        }
        const sf = sourceFile(parsed.path);
        if (!sf) {
          out.push(verdict('invalid', `auto(D-012 ${kase.intent}): not a source file the compiler sees, so it cannot hold a code ${kase.intent} unit`));
          continue;
        }
        if (parsed.line1 > sf.getLineStarts().length) {
          out.push(verdict('invalid', auto('line is past the end of the file', '')));
          continue;
        }
        const text = lineText(sf, parsed.line1);
        const subject = subjectOf(kase);
        if (subject.symbols.size === 0) {
          out.push(undecided(`no declaration of ${kase.subject} resolved in the frozen tree`));
          continue;
        }
        if (kase.intent === 'definition') {
          const impls = subject.decls.filter(hasImplementation).map(nameSite);
          const canon = impls[0] ?? [...subject.declSites][0]!;
          if (impls.includes(site)) out.push(verdict('valid', auto('the subject declaration', text)));
          else if (subject.declSites.has(site)) out.push(verdict('alias', auto('an overload or declaration-file declaration of the subject', text), canon));
          else out.push(verdict('invalid', auto('not a declaration of the subject', text)));
          continue;
        }
        if (subject.declSites.has(site) && (kase.intent === 'callers' || kase.intent === 'references')) {
          out.push(verdict('neutral', auto("the subject's own declaration", text)));
          continue;
        }
        if (kase.intent === 'references') {
          const idents: Node[] = [];
          const lineStart = sf.getLineStarts()[parsed.line1 - 1]!;
          const lineEnd = parsed.line1 < sf.getLineStarts().length ? sf.getLineStarts()[parsed.line1]! : sf.text.length;
          const visit = (n: Node): void => {
            if (n.end < lineStart || n.getStart(sf) >= lineEnd) return;
            if (ts.isIdentifier(n) && n.text === kase.subject && n.getStart(sf) >= lineStart) idents.push(n);
            n.forEachChild(visit);
          };
          visit(sf);
          if (idents.some((n) => subject.symbols.has(symbolAt(n)!))) {
            out.push(verdict('valid', auto('an identifier resolving to the subject', text)));
            continue;
          }
          // D-013: a scope-granularity answer (the enclosing scope's declaration line, or line 1 for
          // the module top level) aliases the first referencing line in that scope.
          const refs = referencesIn(sf, subject, `${kase.subject}|${kase.anchorFile ?? ''}`);
          const declScope = scopeForLine(sf, parsed.line1);
          const scopeRefs =
            parsed.line1 === 1 && !(declScope && declScope.declLines.has(1))
              ? refs.filter((r) => r.scope === null)
              : declScope && declScope.declLines.has(parsed.line1)
                ? refs.filter((r) => r.scope === declScope)
                : [];
          if (scopeRefs.length > 0) {
            const first = Math.min(...scopeRefs.map((r) => r.line1));
            out.push(verdict('alias', auto('scope-granularity answer: the first referencing line in that scope', text), `${parsed.path}:${first}`));
          } else if (idents.length === 0) out.push(verdict('invalid', auto(`no identifier ${kase.subject} on the line (a string or comment is not a reference)`, text)));
          else out.push(verdict('invalid', auto('the identifier resolves to a different symbol', text)));
          continue;
        }
        const subjectKey = `${kase.subject}|${kase.anchorFile ?? ''}`;
        if (kase.intent === 'callers') {
          const scope = scopeForLine(sf, parsed.line1);
          const label = scope ? scope.label : 'module top level';
          const mine = callsTo(sf, subject, subjectKey).filter((c) => c.scope === scope);
          if (mine.length === 0) {
            out.push(verdict('invalid', auto(`no call to ${kase.subject} in calling scope ${label}`, text)));
            continue;
          }
          // D-013 module scope: line 1 stands for the file's top level, so it aliases the first top-level call.
          const unitLines = new Set([...mine.map((c) => c.line1), ...(scope ? [...scope.declLines] : [1])]);
          const existing = [...keyValid].map(parseSiteKey).find((p) => p && p.path === parsed.path && unitLines.has(p.line1) && p.line1 !== parsed.line1);
          const firstLine = Math.min(...mine.map((c) => c.line1));
          const canon = existing ? `${existing.path}:${existing.line1}` : `${parsed.path}:${firstLine}`;
          if (!existing && firstLine === parsed.line1) out.push(verdict('valid', auto(`first call to ${kase.subject} in calling scope ${label}`, text)));
          else if (unitLines.has(parsed.line1)) out.push(verdict('alias', auto(`another call line or the declaration line of calling scope ${label}`, text), canon));
          else out.push(verdict('invalid', auto(`inside calling scope ${label} but neither a call to ${kase.subject} nor the scope's declaration line`, text)));
          continue;
        }
        // callees
        const idx = calleesOf(kase, subject);
        if (!idx.hasBody) {
          out.push(undecided(`no function body found for ${kase.subject}`));
          continue;
        }
        if (subject.declSites.has(site)) out.push(verdict('neutral', auto("the subject's own declaration", text)));
        else if (idx.canonical.has(site)) out.push(verdict('valid', auto(`declaration of first-party callee ${idx.canonical.get(site)}`, text)));
        else if (idx.aliases.has(site)) out.push(verdict('alias', auto('another declaration line of a first-party callee', text), idx.aliases.get(site)));
        else if (idx.ambiguous.has(site)) out.push(undecided('interface/type member reached through an injected dependency: the callee is not statically known'));
        else if (idx.callLines.has(site)) {
          const targets = [...idx.callLines.get(site)!];
          if (targets.length === 1) out.push(verdict('alias', auto('a call line in the subject naming one first-party callee', text), targets[0]));
          else out.push(undecided(`call line names ${targets.length} first-party callees`));
        } else if (idx.externalLines.has(site)) out.push(verdict('neutral', auto('a call into a built-in or third-party package', text)));
        else out.push(verdict('invalid', auto(`not the declaration of anything ${kase.subject} calls`, text)));
      }
      return out;
    },
  };
}

export interface UndecidedSite {
  readonly caseId: string;
  readonly site: SiteKey;
  readonly reason: string;
  readonly namedBy: readonly string[];
}

export interface AutoAdjudication {
  /** Existing verdicts plus the accepted auto verdicts, keyed by case. Existing verdicts are never rewritten. */
  readonly verdicts: Record<string, AdjudicationVerdict[]>;
  readonly undecided: UndecidedSite[];
  readonly accepted: number;
}

/**
 * Run the adjudicator over a scorer's pending pool and merge the result into the recorded
 * verdicts. Each site's verdicts are folded into the case key one site at a time with
 * `applyAdjudication`, so a ruling that contradicts an earlier one (for instance an alias
 * target the adjudicator also ruled invalid) is refused for that site alone and left for hand
 * review with the conflict as its reason. Nothing already recorded is overwritten.
 */
export function autoAdjudicatePending(
  adjudicator: Adjudicator,
  cases: readonly FairCase[],
  seedKeys: readonly AnswerKey[],
  pending: ReadonlyArray<{ readonly caseId: string; readonly sites: readonly SiteKey[]; readonly namedBy: Readonly<Record<SiteKey, readonly string[]>> }>,
  existing: Readonly<Record<string, readonly AdjudicationVerdict[]>>,
): AutoAdjudication {
  const verdicts: Record<string, AdjudicationVerdict[]> = Object.fromEntries(Object.entries(existing).map(([k, v]) => [k, [...v]]));
  const undecided: UndecidedSite[] = [];
  const caseOf = new Map(cases.map((c) => [c.id, c]));
  let accepted = 0;
  for (const p of pending) {
    const kase = caseOf.get(p.caseId);
    const seed = seedKeys.find((k) => k.caseId === p.caseId);
    if (!kase || !seed) {
      for (const site of p.sites) undecided.push({ caseId: p.caseId, site, reason: 'case or seed key not in the corpus', namedBy: p.namedBy[site] ?? [] });
      continue;
    }
    let key = applyAdjudication(seed, verdicts[p.caseId] ?? []);
    for (const ruling of adjudicator.adjudicate(kase, p.sites, key)) {
      const namedBy = p.namedBy[ruling.site] ?? [];
      if (ruling.verdicts.length === 0) {
        undecided.push({ caseId: p.caseId, site: ruling.site, reason: ruling.undecided ?? 'no verdict', namedBy });
        continue;
      }
      try {
        key = applyAdjudication(key, ruling.verdicts);
      } catch (err) {
        undecided.push({ caseId: p.caseId, site: ruling.site, reason: `refused: ${err instanceof Error ? err.message : String(err)}`, namedBy });
        continue;
      }
      (verdicts[p.caseId] ??= []).push(...ruling.verdicts);
      accepted += ruling.verdicts.length;
    }
  }
  return { verdicts, undecided, accepted };
}
