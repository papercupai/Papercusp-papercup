import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const contract = ts.createSourceFile('telemetry-kinds.ts',
  readFileSync(new URL('../telemetry-kinds.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const disclosure = readFileSync(new URL(
  '../../../../apps/operator-docs/src/content/docs/posthog/index.mdx', import.meta.url,
), 'utf8');

function fields(shape: ts.ObjectLiteralExpression): string[] {
  return shape.properties.map(property => {
    if (!ts.isPropertyAssignment(property) ||
      (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) {
      throw new Error('Cloud disclosure guard requires a named closed schema property');
    }
    return property.name.text;
  });
}

/** Derive the population from production schema declarations, including future additions. */
function cloudFields(): Map<string, string[]> {
  const events = new Map<string, string[]>();
  let aggregate: string[] | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'cloudEvent') {
      const [event, properties] = node.arguments;
      if (!event || !ts.isStringLiteral(event) || !properties || !ts.isObjectLiteralExpression(properties)) {
        throw new Error('Cloud event schema changed shape; update the disclosure population reader');
      }
      events.set(event.text, fields(properties));
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      node.name.text === 'cloudDiagnosticAggregateSchema' && node.initializer) {
      const findAggregate = (child: ts.Node) => {
        if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression) &&
          child.expression.name.text === 'object' && child.arguments[0] &&
          ts.isObjectLiteralExpression(child.arguments[0])) aggregate = fields(child.arguments[0]);
        ts.forEachChild(child, findAggregate);
      };
      findAggregate(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(contract);
  if (!aggregate?.length || events.size < 6) throw new Error('Cloud schema population is incomplete');
  events.set('cloud_diagnostic_aggregate', aggregate);
  return events;
}

describe('maintained cloud monitoring disclosure', () => {
  it('names every allowed event and property from the production closed schemas', () => {
    const rows = disclosure.split('\n').filter(line => line.startsWith('| `cloud_') || line.startsWith('| `product_tutorial`'));
    for (const [event, properties] of cloudFields()) {
      const row = rows.find(line => line.startsWith(`| \`${event}\` |`));
      expect(row, `missing disclosure row for ${event}`).toBeDefined();
      for (const property of properties) expect(row, `${event}.${property}`).toContain(`\`${property}\``);
    }
  });

  it('discloses the destination, retention limit and future-delivery effect of revocation', () => {
    expect(disclosure).toContain('flags.papercuspai.com');
    expect(disclosure).toContain('no enforced event-deletion limit');
    expect(disclosure).toContain('stops future delivery');
    expect(disclosure).toContain('does not delete events already delivered');
  });

  it('gives each exported event a distinct explicit purpose beside its allowed fields', () => {
    const rows = disclosure.split('\n').filter(line => line.startsWith('| `cloud_') || line.startsWith('| `product_tutorial`'));
    const purposes = new Set<string>();
    for (const event of cloudFields().keys()) {
      const matches = rows.filter(line => line.startsWith(`| \`${event}\` |`));
      expect(matches, `purpose row population for ${event}`).toHaveLength(1);
      const cells = matches[0]!.split('|').map(cell => cell.trim());
      expect(cells, `event, purpose and property columns for ${event}`).toHaveLength(5);
      const purpose = cells[2]!;
      expect(purpose, `explicit purpose for ${event}`).toMatch(/[A-Za-z].*[A-Za-z]/);
      expect(purpose, `placeholder purpose for ${event}`).not.toMatch(/^(?:unknown|none|n\/a|todo|tbd|\.{3}|-+)$/i);
      expect(purpose.length, `useful purpose for ${event}`).toBeGreaterThan(12);
      expect(purposes.has(purpose), `distinct purpose for ${event}`).toBe(false);
      purposes.add(purpose);
    }
    expect(purposes.size).toBe(cloudFields().size);
  });
});
