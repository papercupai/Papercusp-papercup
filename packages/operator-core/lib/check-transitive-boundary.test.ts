import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
// eslint-disable-next-line import/no-relative-packages
import {
  extractImports,
  formatChain,
  resolveModulePath,
  walkGraph,
} from '../../../scripts/check-transitive-boundary.mjs';

const roots: string[] = [];

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'papercusp-boundary-'));
  roots.push(root);
  for (const [rel, source] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, source);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('transitive client/server boundary preflight', () => {
  it('reports computed import sites without returning their expressions and keeps literal templates and import-equals', () => {
    const source = ts.createSourceFile('sample.ts', [
      "import './side-effect'; export { value } from './reexport';",
      "const text = \"import('never-emit-me')\"; // require('never-emit-me')",
      'import(`./literal`); require(`./legacy`);',
      "import legacy = require('./import-equals');",
      "import type onlyType = require('./type-only');",
      "import('never-emit-me' + suffix); require(privatePath);",
    ].join('\n'), ts.ScriptTarget.Latest, true);
    const unresolved: Array<{ kind: string; line: number }> = [];
    expect(extractImports(source, { onUnresolved: site => unresolved.push(site) })).toEqual([
      { spec: './side-effect', kind: 'import', typeOnly: false, line: 1 },
      { spec: './reexport', kind: 'export', typeOnly: false, line: 1 },
      { spec: './literal', kind: 'dynamic-import', typeOnly: false, line: 3 },
      { spec: './legacy', kind: 'require', typeOnly: false, line: 3 },
      { spec: './import-equals', kind: 'import-equals', typeOnly: false, line: 4 },
      { spec: './type-only', kind: 'import-equals', typeOnly: true, line: 5 },
    ]);
    expect(unresolved).toEqual([{ kind: 'dynamic-import', line: 6 }, { kind: 'require', line: 6 }]);
    expect(JSON.stringify(unresolved)).not.toContain('never-emit-me');
  });

  it('ignores erased type imports but retains value import line metadata', () => {
    const source = ts.createSourceFile(
      'sample.ts',
      [
        "import type { Stats } from 'node:fs';",
        "export type { PathLike } from 'node:fs';",
        "import { readFileSync } from 'node:fs';",
      ].join('\n'),
      ts.ScriptTarget.Latest,
      true,
    );

    expect(extractImports(source)).toEqual([
      { spec: 'node:fs', kind: 'import', typeOnly: true, line: 1 },
      { spec: 'node:fs', kind: 'export', typeOnly: true, line: 2 },
      { spec: 'node:fs', kind: 'import', typeOnly: false, line: 3 },
    ]);
  });

  it('aggregates every forbidden import site and preserves a complete chain to each one', () => {
    const root = fixture({
      'main.ts': "import './left';\nimport './right';\n",
      'left.ts': "import './shared';\n",
      'right.ts': "import { Client } from 'postgres';\n",
      'shared.ts': "import type { Stats } from 'node:fs';\nimport { readFileSync } from 'node:fs';\n",
    });

    const result = walkGraph(join(root, 'main.ts'));
    expect([...result.violations.keys()].sort()).toEqual(['node:fs', 'postgres']);
    expect(result.violations.get('node:fs')).toHaveLength(1);
    expect(result.violations.get('postgres')).toHaveLength(1);

    const nodeViolation = result.violations.get('node:fs')![0];
    expect(nodeViolation.line).toBe(2);
    expect(nodeViolation.chain.map((path: string) => path.split('/').at(-1))).toEqual([
      'main.ts',
      'left.ts',
      'shared.ts',
    ]);
    expect(formatChain(nodeViolation.chain, 'node:fs', nodeViolation.line)).toContain('node:fs (line 2)');
  });

  it('walks only the explicitly client-safe operator-core leaves across the package seam', () => {
    const safeLeaves = [
      'agent-tools/coordination/owner-chat-turn',
      'agent-tools/coordination/status-display',
      'sync-resolver/agent-runs-list-query',
      'sync-resolver/coord-ui-projection',
      'sync-resolver/learning-retain-types',
    ];

    for (const leaf of safeLeaves) {
      const spec = `@papercusp/operator-core/lib/${leaf}`;
      const resolved = resolveModulePath(spec, resolve(__dirname, 'entry.ts'));
      expect(resolved, `${spec} should resolve to its source leaf`).not.toBeNull();
      const result = walkGraph(resolved!);
      expect([...result.violations.keys()], `${spec} must stay free of forbidden imports`).toEqual([]);
    }

    const forbidden = '@papercusp/operator-core/lib/agent-tools/coordination/tools/send';
    const root = fixture({ 'main.ts': `import '${forbidden}';\n` });
    const result = walkGraph(join(root, 'main.ts'));
    expect([...result.violations.keys()]).toEqual([forbidden]);
  });

  it('the CLI prints all full chains in one run without a second verbose invocation', () => {
    const root = fixture({
      'main.ts': "import './first';\nimport './second';\n",
      'first.ts': "import { readFileSync } from 'node:fs';\n",
      'second.ts': "import { createServer } from 'node:http';\n",
    });
    const script = resolve(__dirname, '../../../scripts/check-transitive-boundary.mjs');
    const run = spawnSync(process.execPath, [script, join(root, 'main.ts')], {
      encoding: 'utf8',
      timeout: 30_000,
      killSignal: 'SIGKILL',
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Found 2 forbidden import(s)');
    expect(run.stderr).toContain('main.ts');
    expect(run.stderr).toContain('first.ts');
    expect(run.stderr).toContain('second.ts');
    expect(run.stderr).toContain('node:fs (line 1)');
    expect(run.stderr).toContain('node:http (line 1)');
    expect(run.stderr).not.toContain('Run with --verbose');
  });
});
