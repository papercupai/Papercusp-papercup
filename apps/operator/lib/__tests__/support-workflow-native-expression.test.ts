import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('compiles literal support workflow bridge expressions after TypeScript string decoding', () => {
  const path = new URL('../../e2e/support-workflow-native.spec.mts', import.meta.url);
  const source = ts.createSourceFile(path.pathname, readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const expressions: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && ['check', 'measure'].includes(node.expression.text)) {
      const argument = node.arguments[0];
      if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
        expressions.push(argument.text);
        expect(() => new Script(`(${argument.text})`), argument.text).not.toThrow();
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(expressions.some(expression => expression.includes('Enterprise workspace'))).toBe(true);
  expect(expressions.some(expression => expression.includes('Supporting workspace evidence'))).toBe(true);
});
