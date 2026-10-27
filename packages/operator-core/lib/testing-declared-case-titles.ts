/** Source preflight for named citations; execution and pass/skip proof stay with the ledger. */
import ts from 'typescript';
import { normalizedCaseTitle } from './testing-case-filter';

const UNKNOWN = '\u0000';

/** Collect literal describe/it paths without importing or executing a test module.
 * Computed/parameterized segments remain unknown. Their surrounding literal text
 * bounds which selectors need runtime collection; one dynamic case must not exempt
 * every unrelated selector in the file from validation.
 */
export function declaredCaseTitles(file: string, source: string): { titles: string[]; unresolvedTitles: string[] } {
  // TSX treats a TypeScript generic arrow such as async <T>(...) as JSX and
  // can consume every following suite. Only JSX-bearing extensions use that grammar.
  const scriptKind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX
    : /\.jsx$/.test(file) ? ts.ScriptKind.JSX
      : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, scriptKind);
  const aliases = new Map<string, string>([['it', 'it'], ['test', 'test'], ['describe', 'describe'], ['suite', 'suite']]);
  const namespaces = new Set<string>();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
        !['vitest', '@playwright/test', 'node:test'].includes(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (statement.moduleSpecifier.text === 'node:test' && statement.importClause?.name) {
      aliases.set(statement.importClause.name.text, 'test');
    }
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) aliases.set(element.name.text, element.propertyName?.text ?? element.name.text);
    }
  }
  const titles: string[] = [];
  const unresolvedTitles: string[] = [];
  const chain = (expression: ts.Expression): string[] => {
    if (ts.isIdentifier(expression)) return [aliases.get(expression.text) ?? expression.text];
    if (ts.isPropertyAccessExpression(expression)) {
      if (ts.isIdentifier(expression.expression) && namespaces.has(expression.expression.text)) return [expression.name.text];
      return [...chain(expression.expression), expression.name.text];
    }
    if (ts.isCallExpression(expression)) return chain(expression.expression);
    if (ts.isTaggedTemplateExpression(expression)) return chain(expression.tag);
    return [];
  };
  const visit = (node: ts.Node, parents: string[]): void => {
    if (ts.isCallExpression(node)) {
      const names = chain(node.expression);
      const root = names[0];
      const suite = root === 'describe' || root === 'suite' || (root === 'test' && names.includes('describe'));
      const test = root === 'it' || root === 'test';
      const callback = node.arguments.find(arg => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
      if ((suite || test) && node.arguments.length >= 2) {
        const first = node.arguments[0];
        let literal = first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) ? first.text : UNKNOWN;
        if (first && ts.isTemplateExpression(first)) {
          literal = first.head.text + first.templateSpans.map(span => UNKNOWN + span.literal.text).join('');
        }
        const parameterized = names.includes('each') || names.includes('for');
        if (parameterized) literal = literal.replace(/%[sdifjoO#]|\$[\w.]+|\$#/g, UNKNOWN).replace(/%%/g, '%');
        if (suite) {
          if (callback) visit(callback, [...parents, literal]);
          else unresolvedTitles.push([...parents, literal, UNKNOWN].join(' > '));
        } else {
          const title = [...parents, literal].join(' > ');
          (title.includes(UNKNOWN) ? unresolvedTitles : titles).push(title);
        }
        return;
      }
    }
    ts.forEachChild(node, child => visit(child, parents));
  };
  visit(sf, []);
  return { titles, unresolvedTitles };
}

/** This means UNKNOWN until collection, never a measured match or pass. */
export function mayMatchUnresolvedCaseTitle(declared: string, unresolved: readonly string[]): boolean {
  const identity = normalizedCaseTitle(declared);
  return unresolved.some(title => {
    const hierarchy = title.split(' > ');
    return hierarchy.some((_, start) => {
      const suffix = normalizedCaseTitle(hierarchy.slice(start).join(' > '));
      const parts = suffix.split(UNKNOWN);
      if (parts.length === 1) return identity === suffix;
      if (!identity.startsWith(parts[0]!) || !identity.endsWith(parts.at(-1)!)) return false;
      let cursor = parts[0]!.length;
      for (const part of parts.slice(1, -1)) {
        const found = identity.indexOf(part, cursor);
        if (found < 0) return false;
        cursor = found + part.length;
      }
      return cursor <= identity.length - parts.at(-1)!.length;
    });
  });
}
