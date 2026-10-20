/**
 * P-001 / R-14: audit the owner-required inventory against the first-party
 * interaction and acceptance contracts. This checks authored coverage, not
 * execution: only reporter-harvested installed-product receipts prove a row.
 * Keep this separate from the PTY suite so adding an audit does not invalidate
 * its completed installed-product measurements.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { describe, expect, test } from 'vitest';
import { loadAcceptanceMatrix, loadRequiredMatrix, REPO_ROOT } from './release-acceptance';

// Independent population from R-14 / D-007, not derived from the two tables
// being compared: removing a row from both must still fail this audit.
const OWNER_REQUIRED = [
  'First prompt and streamed response',
  'Persona, tools and permissions',
  'Editable task list',
  'Plans and work-item links',
  'Multiline prompt editing',
  'Transcript navigation and copying',
  'Tool requests and command output',
  'Code changes and diffs',
  'Approvals and permission scope',
  'Interactive questions',
  'New/switch/rename/archive sessions',
  'Legacy history continuation and fork',
  'Interrupt, end and recovery',
  'Model/account/effort/mode settings',
  'Context, usage and compaction',
  'Commands, help, skills and plugins',
  'Files and attachments',
  'Authentication and first-run setup',
  'Installation, update and support',
] as const;

function inventoryRows(markdown: string): string[][] {
  const section = markdown.split('## Required replacement matrix\n')[1]?.split('\n## ')[0];
  if (!section) throw new Error('Missing native capability inventory');
  return section.split('\n').filter(line => line.startsWith('|')).slice(2)
    .map(line => line.slice(1, -1).split('|').map(cell => cell.trim()));
}

/** Parse executable emissions, so comments and orphan tag strings cannot count. */
function acceptanceCases(source: string): Map<string, string[]> {
  const file = ts.createSourceFile('agent-chat-pty.integration.test.ts', source, ts.ScriptTarget.Latest, true);
  const cases = new Map<string, string[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(file) === 'console'
      && ['info', 'log'].includes(node.expression.name.text)
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      const tag = node.arguments[0].text;
      if (tag.endsWith('_ACCEPTANCE')) {
        for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
          if (!ts.isCallExpression(parent) || !parent.arguments[0]
            || !ts.isStringLiteral(parent.arguments[0])) continue;
          const callee = parent.expression.getText(file);
          if (!/^(test|it)(?:\b|\.)/.test(callee) || /\.(skip|todo)\b/.test(callee)) continue;
          cases.set(tag, [...(cases.get(tag) ?? []), parent.arguments[0].text]);
          break;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return cases;
}

function audit(input: {
  inventory: string[][];
  required: string[];
  mapped: Record<string, string[]>;
  cases: Map<string, string[]>;
}): void {
  expect(input.inventory.map(row => row[0])).toEqual(OWNER_REQUIRED);
  expect(input.required).toEqual(OWNER_REQUIRED);
  expect(Object.keys(input.mapped).sort()).toEqual([...OWNER_REQUIRED].sort());
  for (const [capability, home, work, probe] of input.inventory) {
    expect(home, `${capability}: first-party PUI home`).toBeTruthy();
    expect(work, `${capability}: implementation items`).toMatch(/^P-\d{3}(?:, P-\d{3})*$/);
    expect(probe, `${capability}: installed-product probe`).toBeTruthy();
    const tags = input.mapped[capability!];
    expect(tags?.length, `${capability}: installed-product acceptance tags`).toBeGreaterThan(0);
    for (const tag of tags!) {
      expect(input.cases.get(tag)?.length, `${capability}: executable installed-product case for ${tag}`)
        .toBeGreaterThan(0);
    }
  }
}

function currentContracts() {
  return {
    inventory: inventoryRows(readFileSync(path.join(REPO_ROOT, 'apps/tui/NATIVE_CAPABILITIES.md'), 'utf8')),
    required: loadRequiredMatrix().capabilities,
    mapped: loadAcceptanceMatrix().capabilities,
    cases: acceptanceCases(readFileSync(path.join(REPO_ROOT,
      'packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts'), 'utf8')),
  };
}

describe('P-001 native-client capability inventory audit (authored coverage)', () => {
  test('AUTO-BAR-R-14-P-001: every owner-required native capability has a PUI home, implementation items and an installed-product acceptance case', () => {
    audit(currentContracts());
  });

  test('a capability removed from the inventory, UX and acceptance map together still fails', () => {
    const input = currentContracts();
    const removed = OWNER_REQUIRED[2];
    input.inventory = input.inventory.filter(row => row[0] !== removed);
    input.required = input.required.filter(capability => capability !== removed);
    delete input.mapped[removed];
    expect(() => audit(input)).toThrow();
  });

  test.each(['PUI home', 'implementation items', 'installed-product probe'])(
    'a required row with no %s fails', (_field) => {
      const input = currentContracts();
      const column = ['PUI home', 'implementation items', 'installed-product probe'].indexOf(_field) + 1;
      input.inventory[0]![column] = '';
      expect(() => audit(input)).toThrow();
    },
  );

  test('a mapped tag without an executable acceptance case fails', () => {
    const input = currentContracts();
    input.mapped[OWNER_REQUIRED[0]] = ['PUI_UNAUTHORED_ACCEPTANCE'];
    expect(() => audit(input)).toThrow();
  });

  test('comments, unexecuted tag strings and skipped tests cannot supply a case', () => {
    expect(acceptanceCases(`
      // console.info('PUI_COMMENT_ACCEPTANCE', {});
      const orphan = 'PUI_ORPHAN_ACCEPTANCE';
      console.info('PUI_OUTSIDE_TEST_ACCEPTANCE', {});
      test.skip('skipped', () => console.info('PUI_SKIPPED_ACCEPTANCE', {}));
      test('installed journey', () => console.info('PUI_REAL_ACCEPTANCE', {}));
    `)).toEqual(new Map([['PUI_REAL_ACCEPTANCE', ['installed journey']]]));
  });
});
