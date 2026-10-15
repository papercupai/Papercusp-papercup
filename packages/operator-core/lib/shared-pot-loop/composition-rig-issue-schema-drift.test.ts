/** Issue read-column and rig syntax guards. Schema compatibility now runs
 *  against the canonical engineer_issues view in the sibling integration test,
 *  rather than inferring columns from a private migration slice (EI-10579). */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const RIG_FILE = join(HERE, 'composition-rig.ts');
const ISSUES_ENGINEER_FILE = resolve(HERE, '..', 'issues-engineer.ts');

/**
 * Pure, exported for its own coverage: the column list `ISSUE_COLS`
 * (issues-engineer.ts) selects from the `engineer_issues` relation.
 */
export function extractIssueCols(issuesEngineerSource: string): string[] {
  const m = issuesEngineerSource.match(/const ISSUE_COLS\s*=\s*`([\s\S]*?)`/);
  if (!m) {
    throw new Error(
      'extractIssueCols: could not find `const ISSUE_COLS = `…`` in issues-engineer.ts — did its shape change?',
    );
  }
  return m[1]
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && /^[a-z_][a-z0-9_]*$/i.test(c));
}

describe('issue read-column reader', () => {
  it('finds the complete production issue read list', () => {
    const cols = extractIssueCols(readFileSync(ISSUES_ENGINEER_FILE, 'utf8'));
    expect(cols).toEqual(expect.arrayContaining(['issue_id', 'kind', 'state', 'feature_order', 'terminal_owner']));
    expect(cols.length).toBeGreaterThan(15);
  });
  it('refuses a missing reader instead of silently checking no columns', () => {
    expect(() => extractIssueCols('SELECT 1')).toThrow('could not find');
  });
});

describe('composition-rig.ts parses cleanly — the guard must not be blind to its own fixture breaking (EI-18752123064847436)', () => {
  it('is syntactically valid TypeScript (a parse error here would otherwise pass every text-scanning check above)', () => {
    const rigSrc = readFileSync(RIG_FILE, 'utf8');
    const { diagnostics } = ts.transpileModule(rigSrc, {
      fileName: RIG_FILE,
      compilerOptions: { target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
    });

    if (diagnostics && diagnostics.length > 0) {
      const messages = diagnostics.map((d) => {
        const loc = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : undefined;
        const where = loc ? `${loc.line + 1}:${loc.character + 1}` : '?';
        return `  ${where}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
      });
      throw new Error(
        `composition-rig.ts fails to PARSE as TypeScript (${diagnostics.length} syntax error(s)) — every ` +
          `text-scanning check in this file operates on the file's TEXT and cannot detect this, so a broken ` +
          `composition-rig.ts would pass them all while every rig test that imports the module fails elsewhere ` +
          `with no pointer back here. Errors:\n${messages.join('\n')}`,
      );
    }

    expect(diagnostics ?? []).toEqual([]);
  });
});
